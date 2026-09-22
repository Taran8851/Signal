//! read_page for the research agent and the MCP server: a page's readable text and its links.
//! Reading is tried the cheap way first:
//!   1. Signal's fetcher (local, free, robots.txt and public-address checks)
//!   2. if the page is nearly empty (it draws itself with JavaScript): the embedded Obscura
//!   3. if still empty and Firecrawl is set up: Firecrawl's reader (spends a credit)
//! The text is what the page says. The agent treats it as data, never as instructions.

use serde::Serialize;
use url::Url;

use crate::fetch::{fetch_url, FetchReq};

const MAX_TEXT: usize = 12_000;
const MAX_LINKS: usize = 80;
const THIN_TEXT: usize = 400;
// A page counts as drawn by JavaScript only when its HTML is big but its text is tiny. A page that
// is simply short (example.com) is read as it is, so no render and no Firecrawl credit is spent.
const JS_PAGE_HTML: usize = 15_000;

#[derive(Serialize, Clone)]
pub struct Link {
    pub text: String,
    pub url: String,
}

#[derive(Serialize)]
pub struct PageOut {
    pub ok: bool,
    pub url: String,
    pub title: String,
    pub text: String,
    pub links: Vec<Link>,
    /// "fetch", "obscura" or "firecrawl".
    pub engine: String,
    /// The HTML, for the console's own extractor (sources.js readPage). Not sent over MCP.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub async fn read_page(url: &str, with_html: bool) -> PageOut {
    let mut out = PageOut { ok: false, url: url.to_string(), title: String::new(), text: String::new(), links: vec![], engine: String::new(), html: None, error: None };
    // Stealth reading (off unless the user turned it on): Obscura with its browser fingerprint
    // reads the page first. The robots.txt and public-address checks still run before it.
    if crate::search::load_settings().stealth {
        let r = fetch_url(FetchReq::render(url, true)).await;
        if r.ok && r.engine == Some("obscura-stealth") {
            let base = r.url.clone().unwrap_or_else(|| url.to_string());
            let html = r.body.unwrap_or_default();
            out.url = base.clone();
            out.title = title_of(&html);
            out.text = clip(&visible_text(&html), MAX_TEXT);
            out.links = links_of(&html, &base);
            out.engine = "obscura-stealth".into();
            out.ok = true;
            if with_html {
                out.html = Some(html);
            }
            return out;
        }
        if !r.ok && r.error.as_deref().is_some_and(|e| e.contains("robots.txt") || e.contains("Private network")) {
            out.error = r.error;
            return out;
        }
    }
    let plain = fetch_url(FetchReq::get(url, "text/html,application/xhtml+xml,*/*")).await;
    if !plain.ok {
        // Refusals (robots.txt, private address) stop here; no other reader may try.
        out.error = plain.error;
        return out;
    }
    let base = plain.url.clone().unwrap_or_else(|| url.to_string());
    let mut html = plain.body.unwrap_or_default();
    let mut engine = "fetch";
    if visible_text(&html).len() < THIN_TEXT && html.len() > JS_PAGE_HTML {
        let rendered = fetch_url(FetchReq::render(&base, false)).await;
        if rendered.ok && rendered.engine == Some("obscura") {
            let h = rendered.body.unwrap_or_default();
            if visible_text(&h).len() > visible_text(&html).len() {
                html = h;
                engine = "obscura";
            }
        }
    }
    out.url = base.clone();
    out.title = title_of(&html);
    out.text = clip(&visible_text(&html), MAX_TEXT);
    out.links = links_of(&html, &base);
    if out.text.len() < THIN_TEXT && html.len() > JS_PAGE_HTML {
        if let Ok(md) = crate::search::firecrawl_scrape(&base).await {
            out.text = clip(&md, MAX_TEXT);
            engine = "firecrawl";
        }
    }
    out.engine = engine.into();
    out.ok = true;
    if with_html {
        out.html = Some(html);
    }
    out
}

fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

fn title_of(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let Some(start) = lower.find("<title") else { return String::new() };
    let Some(open_end) = lower[start..].find('>') else { return String::new() };
    let from = start + open_end + 1;
    let to = lower[from..].find("</title>").map(|i| from + i).unwrap_or(from);
    strip_tags(&html[from..to])
}

/// Drops elements whose content is never text on the page.
fn drop_blocks(html: &str) -> String {
    let mut s = html.to_string();
    // "<head>" exactly, so a page's <header> isn't taken for it.
    let blocks = [("<script", "</script>"), ("<style", "</style>"), ("<noscript", "</noscript>"), ("<svg", "</svg>"), ("<template", "</template>"), ("<head>", "</head>")];
    for (open, close) in blocks {
        loop {
            let lower = s.to_ascii_lowercase();
            let Some(a) = lower.find(open) else { break };
            let b = lower[a..].find(close).map(|i| a + i + close.len()).unwrap_or(s.len());
            s.replace_range(a..b, " ");
        }
    }
    s
}

pub fn visible_text(html: &str) -> String {
    let cleaned = drop_blocks(html);
    // Block-level tags become line breaks so the text keeps its shape.
    let mut marked = String::with_capacity(cleaned.len());
    let lower = cleaned.to_ascii_lowercase();
    let mut i = 0;
    while let Some(off) = lower[i..].find('<') {
        let at = i + off;
        marked.push_str(&cleaned[i..at]);
        let end = lower[at..].find('>').map(|e| at + e + 1).unwrap_or(cleaned.len());
        let tag = &lower[at..end];
        let block = ["<p", "</p", "<br", "<li", "<h1", "<h2", "<h3", "<h4", "<tr", "<div", "</div", "<section", "<article"]
            .iter()
            .any(|t| tag.starts_with(t));
        marked.push(if block { '\n' } else { ' ' });
        i = end;
    }
    marked.push_str(&cleaned[i..]);
    let decoded = decode_entities(&marked);
    decoded
        .lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    decode_entities(&out).split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        // An entity is short: look for its ';' within the next few characters only.
        let Some(semi) = rest.char_indices().take(12).find(|&(_, c)| c == ';').map(|(i, _)| i) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let name = &rest[1..semi];
        let ch = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            n if n.starts_with("#x") || n.starts_with("#X") => u32::from_str_radix(&n[2..], 16).ok().and_then(char::from_u32),
            n if n.starts_with('#') => n[1..].parse::<u32>().ok().and_then(char::from_u32),
            _ => None,
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

pub fn links_of(html: &str, base: &str) -> Vec<Link> {
    let base = Url::parse(base).ok();
    let lower = html.to_ascii_lowercase();
    let mut out: Vec<Link> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut i = 0;
    while let Some(off) = lower[i..].find("<a ") {
        let at = i + off;
        let Some(tag_end) = lower[at..].find('>').map(|e| at + e) else { break };
        let tag = &html[at..tag_end];
        let close = lower[tag_end..].find("</a>").map(|e| tag_end + e).unwrap_or(tag_end);
        i = close.max(tag_end + 1);
        let href = ["href=\"", "href='"].iter().find_map(|p| {
            let t = tag.to_ascii_lowercase();
            let s = t.find(p)? + p.len();
            let q = p.chars().last().unwrap();
            let e = tag[s..].find(q)? + s;
            Some(decode_entities(&tag[s..e]))
        });
        let Some(href) = href else { continue };
        if href.starts_with('#') || href.starts_with("javascript:") || href.starts_with("mailto:") {
            continue;
        }
        let abs = match &base {
            Some(b) => b.join(&href).map(|u| u.to_string()).unwrap_or(href),
            None => href,
        };
        if !(abs.starts_with("http://") || abs.starts_with("https://")) || !seen.insert(abs.clone()) {
            continue;
        }
        let text = clip(&strip_tags(&html[tag_end + 1..close]), 120);
        out.push(Link { text, url: abs });
        if out.len() >= MAX_LINKS {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_and_links() {
        let html = r##"<html><head><title>Summer &amp; School</title><script>var x = "<p>no</p>";</script></head>
            <body><h1>ML School</h1><p>Apply by <b>1 Oct 2026</b>.</p><a href="/apply">Apply&nbsp;now</a>
            <a href="#top">Top</a><a href='https://other.org/x'>Other</a></body></html>"##;
        assert_eq!(title_of(html), "Summer & School");
        let t = visible_text(html);
        assert!(t.contains("ML School") && t.contains("Apply by 1 Oct 2026 ."), "{t}");
        assert!(!t.contains("var x"), "{t}");
        let l = links_of(html, "https://school.org/page");
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].url, "https://school.org/apply");
        assert_eq!(l[0].text, "Apply now");
        // A lone '&' before multi-byte text must not split a character.
        assert_eq!(decode_entities("R&D विज्ञान &amp; गणित"), "R&D विज्ञान & गणित");
    }
}
