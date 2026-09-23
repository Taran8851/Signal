//! Web search for the research agent and the MCP server. Providers are tried in the order the
//! user set, a provider that fails or is over its limit is skipped, and results are merged
//! and de-duplicated by URL.
//!   - firecrawl_self: the user's own Firecrawl server (web/backend/deploy/firecrawl), address + key. Tried
//!     first when set up: no credits, no limits except the server's.
//!   - firecrawl: Firecrawl's search API with the user's key. A licensed API; no scraping.
//!   - duckduckgo: experimental, off by default. DuckDuckGo's plain-HTML results page, read
//!     through Signal's own fetcher (html.duckduckgo.com's robots.txt allows it; DuckDuckGo's
//!     terms don't welcome it, which is why it is off by default). One request per 3 s at most,
//!     and it never runs as the only provider.
//!   - ddgs: optional, off by default. The `ddgs` metasearch tool (pipx install ddgs), the
//!     same one Unsloth Studio uses. It scrapes several engines' result pages with a disguised
//!     browser fingerprint, which those engines' terms and robots.txt don't allow; the user turns
//!     it on knowing that. Signal only runs the command; it isn't bundled.
//! Settings live in one file (search.json in the app's config folder) so the app and
//! `signal-desktop --mcp` use the same providers, keys and limits.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use url::Url;

const DDG_GAP: Duration = Duration::from_secs(3);

#[derive(Serialize, Deserialize, Clone)]
pub struct Provider {
    pub id: String,
    pub on: bool,
    #[serde(default)]
    pub key: String,
    #[serde(rename = "perDay", default)]
    pub per_day: u32,
    /// Server address, for firecrawl_self (e.g. https://host/firecrawl).
    #[serde(default)]
    pub url: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Settings {
    pub providers: Vec<Provider>,
    /// Stealth reading: read_page uses Obscura's browser fingerprint. Off unless turned on.
    #[serde(default)]
    pub stealth: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            providers: vec![
                Provider { id: "firecrawl_self".into(), on: true, key: String::new(), per_day: 2000, url: String::new() },
                Provider { id: "firecrawl".into(), on: true, key: String::new(), per_day: 100, url: String::new() },
                Provider { id: "ddgs".into(), on: false, key: String::new(), per_day: 300, url: String::new() },
                Provider { id: "duckduckgo".into(), on: false, key: String::new(), per_day: 200, url: String::new() },
            ],
            stealth: false,
        }
    }
}

#[derive(Serialize, Clone)]
pub struct Hit {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub provider: String,
}

#[derive(Serialize)]
pub struct SearchOut {
    pub results: Vec<Hit>,
    /// What each provider did: "12 results", "skipped: no key", "failed: …".
    pub notes: Vec<String>,
}

/// Set at startup from Tauri's app config folder (the same ~/.config/app.studentos.signal on
/// Linux, %APPDATA% on Windows, the app's own folder on Android). `--mcp` runs without a window,
/// so it falls back to working the folder out itself.
static CONFIG_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
pub fn set_config_dir(dir: PathBuf) {
    let _ = CONFIG_DIR.set(dir);
}

pub fn config_dir() -> PathBuf {
    if let Some(d) = CONFIG_DIR.get() {
        return d.clone();
    }
    #[cfg(windows)]
    if let Some(a) = std::env::var_os("APPDATA") {
        return PathBuf::from(a).join("app.studentos.signal");
    }
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("app.studentos.signal")
}

fn settings_path() -> PathBuf {
    config_dir().join("search.json")
}

pub fn load_settings() -> Settings {
    let mut s: Settings = std::fs::read(settings_path())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    // Keep every known provider listed, even if an older file lacks one. Your own server goes
    // first; others are added at the end.
    for d in Settings::default().providers {
        if !s.providers.iter().any(|p| p.id == d.id) {
            if d.id == "firecrawl_self" { s.providers.insert(0, d) } else { s.providers.push(d) }
        }
    }
    s.providers.retain(|p| ["firecrawl_self", "firecrawl", "ddgs", "duckduckgo"].contains(&p.id.as_str()));
    s
}

pub fn save_settings(s: &Settings) -> Result<(), String> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|_| "Signal couldn't create its settings folder.".to_string())?;
    let path = settings_path();
    std::fs::write(&path, serde_json::to_vec_pretty(s).unwrap_or_default()).map_err(|_| "Signal couldn't save the search settings.".to_string())?;
    // The file holds API keys: readable by this user only.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

// Calls made today per provider (in memory; the day rolls over at local midnight of the process's clock).
static USAGE: LazyLock<Mutex<(u64, HashMap<String, u32>)>> = LazyLock::new(|| Mutex::new((0, HashMap::new())));
static DDG_LAST: LazyLock<tokio::sync::Mutex<Option<Instant>>> = LazyLock::new(|| tokio::sync::Mutex::new(None));

fn today() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() / 86400).unwrap_or(0)
}

/// Counts a call against a provider's daily limit; false when the limit is reached.
pub fn take_quota(id: &str, per_day: u32) -> bool {
    let mut u = USAGE.lock().unwrap();
    if u.0 != today() {
        *u = (today(), HashMap::new());
    }
    let n = u.1.entry(id.to_string()).or_insert(0);
    if per_day > 0 && *n >= per_day {
        return false;
    }
    *n += 1;
    true
}

pub fn usage_today() -> HashMap<String, u32> {
    let u = USAGE.lock().unwrap();
    if u.0 != today() {
        return HashMap::new();
    }
    u.1.clone()
}

pub async fn search(query: &str, site: Option<&str>, count: usize) -> SearchOut {
    let settings = load_settings();
    let count = count.clamp(1, 20);
    let q = match site.map(str::trim).filter(|s| !s.is_empty()) {
        Some(site) => format!("{query} site:{site}"),
        None => query.trim().to_string(),
    };
    let mut notes = Vec::new();
    let mut out: Vec<Hit> = Vec::new();
    let mut seen = HashSet::new();
    if q.is_empty() {
        notes.push("No query.".into());
        return SearchOut { results: out, notes };
    }
    let enabled: Vec<&Provider> = settings.providers.iter().filter(|p| p.on).collect();
    let only_ddg = enabled.len() == 1 && enabled[0].id == "duckduckgo";
    if enabled.is_empty() {
        notes.push("No search provider is switched on. Turn one on in Settings → Search & reading.".into());
    }
    for p in enabled {
        if out.len() >= count {
            break;
        }
        if p.id == "duckduckgo" && only_ddg {
            notes.push("duckduckgo: skipped, it can't be the only provider switched on.".into());
            continue;
        }
        if p.id == "firecrawl" && p.key.trim().is_empty() {
            notes.push("firecrawl: skipped, no API key yet.".into());
            continue;
        }
        if p.id == "firecrawl_self" && (p.url.trim().is_empty() || p.key.trim().is_empty()) {
            continue; // not set up: say nothing
        }
        if !take_quota(&p.id, p.per_day) {
            notes.push(format!("{}: skipped, today's limit of {} is used up.", p.id, p.per_day));
            continue;
        }
        let got = match p.id.as_str() {
            "firecrawl" => firecrawl_search(FIRECRAWL_CLOUD, &p.key, &q, count).await,
            "firecrawl_self" => firecrawl_search(p.url.trim(), &p.key, &q, count).await,
            "duckduckgo" => ddg_search(&q).await,
            "ddgs" => ddgs_search(&q, count).await,
            _ => Err("unknown provider".into()),
        };
        match got {
            Ok(hits) => {
                let mut added = 0;
                for h in hits {
                    let key = h.url.trim_end_matches('/').to_lowercase();
                    if seen.insert(key) && out.len() < count {
                        out.push(h);
                        added += 1;
                    }
                }
                notes.push(format!("{}: {} results", p.id, added));
            }
            Err(e) => notes.push(format!("{}: failed, {}", p.id, e)),
        }
    }
    SearchOut { results: out, notes }
}

const FIRECRAWL_CLOUD: &str = "https://api.firecrawl.dev";

async fn firecrawl_search(base: &str, key: &str, q: &str, count: usize) -> Result<Vec<Hit>, String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(60)).user_agent(crate::fetch::UA).build().map_err(|e| e.to_string())?;
    let res = client
        .post(format!("{}/v2/search", base.trim_end_matches('/')))
        .bearer_auth(key.trim())
        .json(&serde_json::json!({ "query": q, "limit": count }))
        .send()
        .await
        .map_err(|_| "Firecrawl couldn't be reached.".to_string())?;
    let status = res.status().as_u16();
    let j: serde_json::Value = res.json().await.unwrap_or_default();
    if status == 401 || status == 403 {
        return Err(format!("the key was refused ({status})"));
    }
    if status == 402 {
        return Err("out of credits (402)".into());
    }
    if status == 429 {
        return Err("rate limited (429)".into());
    }
    if status >= 400 {
        return Err(format!("HTTP {status}: {}", j["error"].as_str().unwrap_or("")));
    }
    // v2 groups results by source; older answers put a list straight in data.
    let list = j["data"]["web"].as_array().or_else(|| j["data"].as_array()).cloned().unwrap_or_default();
    Ok(list
        .iter()
        .filter_map(|r| {
            let url = r["url"].as_str()?.to_string();
            Some(Hit {
                title: r["title"].as_str().unwrap_or("").to_string(),
                snippet: r["description"].as_str().unwrap_or("").to_string(),
                url,
                provider: if base == FIRECRAWL_CLOUD { "firecrawl".into() } else { "firecrawl_self".into() },
            })
        })
        .collect())
}

/// Firecrawl's page reader, for pages that are empty without JavaScript. Returns Markdown.
/// Your own server first (free), then the cloud (a credit), whichever is set up and switched on.
pub async fn firecrawl_scrape(url: &str) -> Result<String, String> {
    let settings = load_settings();
    let mut last = "Firecrawl isn't set up.".to_string();
    for p in settings.providers.iter().filter(|p| p.on && !p.key.trim().is_empty()) {
        let base = match p.id.as_str() {
            "firecrawl_self" if !p.url.trim().is_empty() => p.url.trim().to_string(),
            "firecrawl" => FIRECRAWL_CLOUD.to_string(),
            _ => continue,
        };
        if !take_quota(&p.id, p.per_day) {
            last = format!("{}'s daily limit is used up.", p.id);
            continue;
        }
        match scrape_one(&base, &p.key, url).await {
            Ok(md) => return Ok(md),
            Err(e) => last = e,
        }
    }
    Err(last)
}

async fn scrape_one(base: &str, key: &str, url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(90)).user_agent(crate::fetch::UA).build().map_err(|e| e.to_string())?;
    let res = client
        .post(format!("{}/v2/scrape", base.trim_end_matches('/')))
        .bearer_auth(key.trim())
        .json(&serde_json::json!({ "url": url, "formats": ["markdown"], "onlyMainContent": true }))
        .send()
        .await
        .map_err(|_| "Firecrawl couldn't be reached.".to_string())?;
    let status = res.status().as_u16();
    let j: serde_json::Value = res.json().await.unwrap_or_default();
    if status >= 400 {
        return Err(format!("Firecrawl answered HTTP {status}."));
    }
    j["data"]["markdown"].as_str().map(str::to_string).ok_or_else(|| "Firecrawl returned no page text.".into())
}

/// Where the `ddgs` command is: PATH first, then where pipx and pip --user put it (an app
/// started from the desktop menu often has a shorter PATH than a terminal).
pub fn ddgs_path() -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    // pipx puts it in ~/.local/bin on every platform (%USERPROFILE%\.local\bin on Windows).
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        dirs.push(PathBuf::from(&home).join(".local").join("bin"));
    }
    #[cfg(unix)]
    dirs.push(PathBuf::from("/usr/local/bin"));
    let name = if cfg!(windows) { "ddgs.exe" } else { "ddgs" };
    dirs.into_iter().map(|d| d.join(name)).find(|p| p.is_file())
}

async fn ddgs_search(q: &str, count: usize) -> Result<Vec<Hit>, String> {
    let bin = ddgs_path().ok_or("not installed (install it with: pipx install ddgs)")?;
    // `ddgs text -o json` writes a file into the working folder, so give it a folder of its own.
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("signal-ddgs-{}-{nanos}", std::process::id()));
    tokio::fs::create_dir_all(&dir).await.map_err(|_| "couldn't make a temporary folder".to_string())?;
    let run = tokio::process::Command::new(&bin)
        .args(["text", "-q", q, "-m", &count.to_string(), "-o", "json", "-nc"])
        .current_dir(&dir)
        .kill_on_drop(true)
        .output();
    let result = match tokio::time::timeout(Duration::from_secs(40), run).await {
        Err(_) => Err("took too long".to_string()),
        Ok(Err(_)) => Err("couldn't be started".to_string()),
        Ok(Ok(o)) => {
            let mut hits = Vec::new();
            if let Ok(mut rd) = tokio::fs::read_dir(&dir).await {
                while let Ok(Some(e)) = rd.next_entry().await {
                    if e.path().extension().is_some_and(|x| x == "json") {
                        let bytes = tokio::fs::read(e.path()).await.unwrap_or_default();
                        let list: Vec<serde_json::Value> = serde_json::from_slice(&bytes).unwrap_or_default();
                        hits = list
                            .iter()
                            .filter_map(|r| {
                                let url = r["href"].as_str()?.to_string();
                                Url::parse(&url).ok().filter(|u| u.scheme() == "http" || u.scheme() == "https")?;
                                Some(Hit {
                                    title: r["title"].as_str().unwrap_or("").to_string(),
                                    snippet: r["body"].as_str().unwrap_or("").to_string(),
                                    url,
                                    provider: "ddgs".into(),
                                })
                            })
                            .collect();
                    }
                }
            }
            if hits.is_empty() {
                let err = String::from_utf8_lossy(&o.stderr);
                let line = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("no results");
                Err(line.chars().take(160).collect())
            } else {
                Ok(hits)
            }
        }
    };
    let _ = tokio::fs::remove_dir_all(&dir).await;
    result
}

async fn ddg_search(q: &str) -> Result<Vec<Hit>, String> {
    {
        // At most one request every DDG_GAP, across the whole app.
        let mut last = DDG_LAST.lock().await;
        if let Some(t) = *last {
            let since = t.elapsed();
            if since < DDG_GAP {
                tokio::time::sleep(DDG_GAP - since).await;
            }
        }
        *last = Some(Instant::now());
    }
    let mut u = Url::parse("https://html.duckduckgo.com/html/").unwrap();
    u.query_pairs_mut().append_pair("q", q);
    let res = crate::fetch::fetch_url(crate::fetch::FetchReq::get(u.as_str(), "text/html")).await;
    if !res.ok {
        return Err(res.error.unwrap_or_default());
    }
    let body = res.body.as_deref().unwrap_or("");
    if res.status == Some(202) || body.contains("anomaly-modal") {
        return Err("DuckDuckGo asked for a bot check, and Signal doesn't get around those".into());
    }
    let hits = parse_ddg(body);
    if hits.is_empty() {
        return Err("no results (DuckDuckGo may be blocking automated requests)".into());
    }
    Ok(hits)
}

/// Results on DuckDuckGo's HTML page: `<a class="result__a" href="//duckduckgo.com/l/?uddg=<url>">Title</a>`
/// followed by `<a class="result__snippet" …>Snippet</a>`.
fn parse_ddg(html: &str) -> Vec<Hit> {
    let mut out = Vec::new();
    for chunk in html.split("class=\"result__a\"").skip(1) {
        let Some(href) = attr(chunk, "href") else { continue };
        let Some(title_html) = chunk.split_once('>').map(|(_, rest)| rest.split("</a>").next().unwrap_or("")) else { continue };
        let url = real_url(&href);
        let Some(url) = url else { continue };
        let snippet = chunk
            .split_once("class=\"result__snippet\"")
            .and_then(|(_, rest)| rest.split_once('>'))
            .map(|(_, rest)| rest.split("</a>").next().unwrap_or(""))
            .unwrap_or("");
        out.push(Hit {
            title: crate::page::strip_tags(title_html),
            url,
            snippet: crate::page::strip_tags(snippet),
            provider: "duckduckgo".into(),
        });
    }
    out
}

fn attr(chunk: &str, name: &str) -> Option<String> {
    let start = chunk.find(&format!("{name}=\""))? + name.len() + 2;
    let end = chunk[start..].find('"')? + start;
    Some(crate::page::decode_entities(&chunk[start..end]))
}

/// DuckDuckGo wraps result links in a redirect; the real address is in `uddg`. Ads are dropped.
fn real_url(href: &str) -> Option<String> {
    let full = if href.starts_with("//") { format!("https:{href}") } else { href.to_string() };
    let u = Url::parse(&full).ok()?;
    if u.host_str().is_some_and(|h| h.ends_with("duckduckgo.com")) {
        if u.path().starts_with("/y.js") {
            return None;
        }
        return u.query_pairs().find(|(k, _)| k == "uddg").map(|(_, v)| v.into_owned());
    }
    (u.scheme() == "http" || u.scheme() == "https").then(|| u.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ddg_results() {
        let html = r#"<div><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fsummer%2Dschool&amp;rut=x">ML <b>Summer</b> School &amp; Co</a>
            <a class="result__snippet" href="x">Apply by <b>1 October</b>.</a></div>
            <div><a class="result__a" href="//duckduckgo.com/y.js?ad=1">Ad</a></div>"#;
        let hits = parse_ddg(html);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].url, "https://example.org/summer-school");
        assert_eq!(hits[0].title, "ML Summer School & Co");
        assert_eq!(hits[0].snippet, "Apply by 1 October.");
    }
}
