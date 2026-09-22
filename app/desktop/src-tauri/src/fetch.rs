//! Reads a source for the console. The same rules as web/backend/fetch-helper.mjs, which this
//! replaces on the desktop:
//!   - public http(s) only: every hop's address is resolved and checked, and the request is
//!     pinned to the checked address so DNS can't change it in between
//!   - robots.txt is honoured for the Signal user agent
//!   - no cookies, no caller-supplied headers, no stealth; 3 MB and 20 s caps
//! It answers in the helper's JSON shape, so sources.js handles both the same way.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use texting_robots::Robot;
use url::Url;

pub const UA: &str = "SignalDesktop/0.1 (+student app; respects robots.txt)";
const ROBOT_NAME: &str = "SignalDesktop";
const MAX_BYTES: usize = 3 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_HOPS: usize = 5;

#[derive(Deserialize)]
pub struct FetchReq {
    url: String,
    method: Option<String>,
    body: Option<String>,
    accept: Option<String>,
    /// The page needs JavaScript: render it with the embedded Obscura first.
    #[serde(default)]
    render: bool,
    /// Render with Obscura's stealth mode (Stealth reading). Never set by the console's sources.
    #[serde(skip)]
    stealth: bool,
}

#[derive(Serialize)]
pub struct FetchRes {
    pub(crate) ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) status: Option<u16>,
    #[serde(rename = "contentType", skip_serializing_if = "Option::is_none")]
    pub(crate) content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) engine: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

impl FetchReq {
    pub fn url(&self) -> &str {
        &self.url
    }
    pub fn get(url: &str, accept: &str) -> Self {
        FetchReq { url: url.into(), method: None, body: None, accept: Some(accept.into()), render: false, stealth: false }
    }
    pub fn render(url: &str, stealth: bool) -> Self {
        FetchReq { url: url.into(), method: None, body: None, accept: Some("text/html".into()), render: true, stealth }
    }
}

impl FetchRes {
    /// One line for the log: "ok 200 12345b" or "refused: <why>".
    pub fn summary(&self) -> String {
        if self.ok {
            format!("ok {} {}b", self.status.unwrap_or(0), self.body.as_deref().map_or(0, str::len))
        } else {
            format!("refused: {}", self.error.as_deref().unwrap_or(""))
        }
    }
}

fn fail(message: impl Into<String>) -> FetchRes {
    FetchRes { ok: false, url: None, status: None, content_type: None, body: None, engine: None, error: Some(message.into()) }
}

pub fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            a == 10 || a == 127 || a == 0 || (a == 169 && b == 254) || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168) || (a == 100 && (64..=127).contains(&b)) || a >= 224
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            v6.is_loopback() || v6.is_unspecified() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
                || (first & 0xff00) == 0xff00
        }
    }
}

/// Checks a URL and resolves its host to one public address to pin the request to.
async fn check_url(raw: &str) -> Result<(Url, SocketAddr), String> {
    let u = Url::parse(raw.trim()).map_err(|_| "That isn't a valid link.".to_string())?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err("Only http and https links are allowed.".into());
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err("Links with credentials aren't allowed.".into());
    }
    let host = u.host_str().ok_or("That link has no site name.")?.trim_matches(['[', ']']).to_string();
    let port = u.port_or_known_default().unwrap_or(443);
    let addrs: Vec<SocketAddr> = match tokio::time::timeout(Duration::from_secs(8), tokio::net::lookup_host((host.as_str(), port))).await {
        Ok(Ok(it)) => it.collect(),
        _ => Vec::new(),
    };
    if addrs.is_empty() {
        return Err("That site's name doesn't resolve.".into());
    }
    if addrs.iter().any(|a| is_private(a.ip())) {
        return Err("Private network addresses aren't allowed.".into());
    }
    Ok((u, addrs[0]))
}

fn client_for(u: &Url, addr: SocketAddr) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .user_agent(UA);
    if let Some(host) = u.host_str() {
        if host.parse::<IpAddr>().is_err() {
            b = b.resolve(host, addr);
        }
    }
    b.build().map_err(|_| "Signal couldn't set up a connection.".to_string())
}

// robots.txt per origin, kept for the life of the app. None = no rules (allowed).
static ROBOTS: LazyLock<Mutex<HashMap<String, Option<Robot>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

async fn robots_allows(u: &Url, addr: SocketAddr) -> bool {
    let origin = u.origin().ascii_serialization();
    if let Some(cached) = ROBOTS.lock().unwrap().get(&origin) {
        return cached.as_ref().map_or(true, |r| r.allowed(u.as_str()));
    }
    let mut robot = None;
    let robots_url = format!("{origin}/robots.txt");
    if let Ok(client) = client_for(u, addr) {
        let got = client.get(&robots_url).timeout(Duration::from_secs(8)).send().await;
        // Only a 200 carries rules; a missing or failing robots.txt means allowed (as the helper does).
        if let Ok(res) = got {
            if res.status().is_success() {
                if let Ok(bytes) = res.bytes().await {
                    robot = Robot::new(ROBOT_NAME, &bytes[..bytes.len().min(512 * 1024)]).ok();
                }
            }
        }
    }
    let allowed = robot.as_ref().map_or(true, |r| r.allowed(u.as_str()));
    ROBOTS.lock().unwrap().insert(origin, robot);
    allowed
}

pub async fn fetch_url(req: FetchReq) -> FetchRes {
    let method = req.method.unwrap_or_else(|| "GET".into()).to_uppercase();
    if method != "GET" && method != "POST" {
        return fail("Only GET and POST are allowed.");
    }
    let body = req.body.unwrap_or_default();
    if body.len() > 16 * 1024 {
        return fail("That request body is too large.");
    }
    if method == "POST" && !body.is_empty() && serde_json::from_str::<serde_json::Value>(&body).is_err() {
        return fail("The request body has to be JSON.");
    }
    let accept: String = req.accept.unwrap_or_else(|| "*/*".into()).chars().take(100).collect();
    if accept.contains(['\r', '\n']) {
        return fail("That accept value isn't allowed.");
    }

    let (mut u, mut addr) = match check_url(&req.url).await {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    if !robots_allows(&u, addr).await {
        return fail("This site's robots.txt asks automated readers not to fetch that page, so Signal won't.");
    }

    if req.render && method == "GET" {
        match crate::render::render(u.as_str(), req.stealth).await {
            Ok(html) => {
                return FetchRes {
                    ok: true,
                    url: Some(u.to_string()),
                    status: Some(200),
                    content_type: Some("text/html".into()),
                    body: Some(html),
                    engine: Some(if req.stealth { "obscura-stealth" } else { "obscura" }),
                    error: None,
                }
            }
            // Fall back to a plain request: the page's HTML is still better than nothing.
            Err(e) => eprintln!("render failed, falling back to fetch: {e}"),
        }
    }

    let mut post = method == "POST";
    let mut res;
    let mut hop = 0;
    loop {
        let client = match client_for(&u, addr) {
            Ok(c) => c,
            Err(e) => return fail(e),
        };
        let mut rb = if post {
            client.post(u.as_str()).header("content-type", "application/json").body(body.clone())
        } else {
            client.get(u.as_str())
        };
        rb = rb.header("accept", accept.as_str());
        res = match rb.send().await {
            Ok(r) => r,
            Err(e) if e.is_timeout() => return fail("The site took too long to answer."),
            Err(_) => return fail(format!("Signal couldn't reach {}.", u.host_str().unwrap_or("that site"))),
        };
        let status = res.status();
        if !status.is_redirection() {
            break;
        }
        let Some(loc) = res.headers().get("location").and_then(|v| v.to_str().ok()) else { break };
        if hop >= MAX_HOPS {
            return fail("Too many redirects.");
        }
        hop += 1;
        let next = match u.join(loc) {
            Ok(n) => n,
            Err(_) => return fail("The site redirected to a link Signal can't read."),
        };
        (u, addr) = match check_url(next.as_str()).await {
            Ok(v) => v,
            Err(e) => return fail(e),
        };
        if !robots_allows(&u, addr).await {
            return fail("This site's robots.txt asks automated readers not to fetch that page, so Signal won't.");
        }
        // 307/308 keep the method and body; the others turn into a GET.
        if post && status.as_u16() != 307 && status.as_u16() != 308 {
            post = false;
        }
    }

    let status = res.status().as_u16();
    if status >= 400 {
        return fail(format!("The site answered with an error (HTTP {status})."));
    }
    let content_type = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let mut buf: Vec<u8> = Vec::new();
    loop {
        match res.chunk().await {
            Ok(Some(c)) => {
                if buf.len() + c.len() > MAX_BYTES {
                    return fail("That response is too large.");
                }
                buf.extend_from_slice(&c);
            }
            Ok(None) => break,
            Err(e) if e.is_timeout() => return fail("The site took too long to answer."),
            Err(_) => return fail("The connection dropped while reading that page."),
        }
    }
    FetchRes {
        ok: true,
        url: Some(u.to_string()),
        status: Some(status),
        content_type: Some(content_type),
        body: Some(String::from_utf8_lossy(&buf).into_owned()),
        engine: Some("fetch"),
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_ranges() {
        for ip in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"] {
            assert!(is_private(ip.parse().unwrap()), "{ip} should be private");
        }
        for ip in ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700::1111"] {
            assert!(!is_private(ip.parse().unwrap()), "{ip} should be public");
        }
    }

    #[test]
    fn refuses_localhost_and_bad_links() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            for raw in ["http://127.0.0.1:8787/x", "http://localhost/", "http://[::1]/", "ftp://example.com/", "https://user:pw@example.com/"] {
                let r = fetch_url(FetchReq { url: raw.into(), method: None, body: None, accept: None, render: false, stealth: false }).await;
                assert!(!r.ok, "{raw} should be refused");
            }
        });
    }
}

// Live checks against the sources Signal reads. Run with: cargo test -- --ignored --nocapture
#[cfg(test)]
mod live {
    use super::*;

    fn run(url: &str, method: Option<&str>, body: Option<&str>) -> FetchRes {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(fetch_url(FetchReq {
            url: url.into(),
            method: method.map(Into::into),
            body: body.map(Into::into),
            accept: Some("application/json".into()),
            render: false,
            stealth: false,
        }))
    }

    #[test]
    #[ignore]
    fn real_sources() {
        let season = 2027;
        let cases: Vec<(&str, String, Option<&str>, Option<&str>)> = vec![
            ("devpost", "https://devpost.com/api/hackathons?page=1&status[]=upcoming&status[]=open&order_by=recently-added".into(), None, None),
            ("devfolio", "https://api.devfolio.co/api/search/hackathons".into(), Some("POST"), Some(r#"{"type":"application_open","from":0,"size":50}"#)),
            ("unstop", "https://unstop.com/api/public/opportunity/search-result?opportunity=hackathons&page=1&per_page=30&oppstatus=open".into(), None, None),
            ("mlh", format!("https://www.mlh.com/seasons/{season}/events"), None, None),
            ("wikicfp", "http://www.wikicfp.com/cfp/rss?cat=machine%20learning".into(), None, None),
        ];
        for (name, url, m, b) in cases {
            let t = std::time::Instant::now();
            let r = run(&url, m, b);
            println!("{name:9} ok={} status={:?} bytes={} {}ms {}", r.ok, r.status, r.body.as_deref().map_or(0, str::len), t.elapsed().as_millis(), r.error.unwrap_or_default());
        }
        // A path robots.txt disallows for everyone.
        let r = run("https://www.google.com/search?q=signal", None, None);
        println!("robots    ok={} {}", r.ok, r.error.clone().unwrap_or_default());
        assert!(!r.ok);
    }

    // Plain HTML against the rendered page for a site that draws its list with JavaScript.
    #[test]
    #[ignore]
    fn render_js_page() {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        for url in ["https://unstop.com/hackathons", "https://devfolio.co/hackathons"] {
            let plain = rt.block_on(fetch_url(FetchReq { url: url.into(), method: None, body: None, accept: None, render: false, stealth: false }));
            let t = std::time::Instant::now();
            let rendered = rt.block_on(fetch_url(FetchReq { url: url.into(), method: None, body: None, accept: None, render: true, stealth: false }));
            let links = |b: &Option<String>| b.as_deref().map_or(0, |h| h.matches("<a ").count());
            println!("{url}\n  plain    ok={} bytes={} links={}\n  rendered ok={} engine={:?} bytes={} links={} {}ms {}",
                plain.ok, plain.body.as_deref().map_or(0, str::len), links(&plain.body),
                rendered.ok, rendered.engine, rendered.body.as_deref().map_or(0, str::len), links(&rendered.body),
                t.elapsed().as_millis(), rendered.error.clone().unwrap_or_default());
        }
    }
}
