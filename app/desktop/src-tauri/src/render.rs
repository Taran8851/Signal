//! Renders pages that need JavaScript, with Obscura linked into the app (no sidecar, no
//! download). A V8 isolate can't move between threads, so one worker thread owns the
//! rendering and takes jobs from a queue; renders run one at a time.
//!
//! Callers check the URL (public address, robots.txt) before asking for a render. Obscura
//! itself refuses private network addresses for the page and everything it loads.

use std::sync::mpsc;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use tokio::sync::oneshot;

const NAV_TIMEOUT: Duration = Duration::from_secs(25);
const SETTLE_MS: u64 = 2500;
const MAX_BYTES: usize = 3 * 1024 * 1024;

struct Job {
    url: String,
    stealth: bool,
    reply: oneshot::Sender<Result<String, String>>,
}

static QUEUE: LazyLock<Mutex<Option<mpsc::Sender<Job>>>> = LazyLock::new(|| Mutex::new(None));

fn queue() -> Result<mpsc::Sender<Job>, String> {
    let mut q = QUEUE.lock().unwrap();
    if let Some(tx) = q.as_ref() {
        return Ok(tx.clone());
    }
    let (tx, rx) = mpsc::channel::<Job>();
    std::thread::Builder::new()
        .name("signal-render".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(_) => return,
            };
            for job in rx {
                let out = rt.block_on(render_one(&job.url, job.stealth));
                let _ = job.reply.send(out);
            }
        })
        .map_err(|_| "Signal couldn't start its page renderer.".to_string())?;
    *q = Some(tx.clone());
    Ok(tx)
}

async fn render_one(url: &str, stealth: bool) -> Result<String, String> {
    // Stealth: Obscura's consistent browser fingerprint and TLS impersonation, with its own
    // matching user agent. Otherwise Signal says who it is.
    let builder = obscura::Browser::builder().stealth(stealth);
    let builder = if stealth { builder } else { builder.user_agent(crate::fetch::UA) };
    let browser = builder
        .build()
        .map_err(|e| format!("The page renderer couldn't start: {e}"))?;
    let mut page = browser.new_page().await.map_err(|e| format!("The page renderer couldn't open a page: {e}"))?;
    match tokio::time::timeout(NAV_TIMEOUT, page.goto(url)).await {
        Err(_) => return Err("The page took too long to load.".into()),
        Ok(Err(e)) => return Err(format!("The page renderer couldn't load that page: {e}")),
        Ok(Ok(())) => {}
    }
    // Let the page's scripts fetch and draw their content.
    page.settle(SETTLE_MS).await;
    let html = page.content();
    if html.len() > MAX_BYTES {
        return Err("That page is too large.".into());
    }
    Ok(html)
}

/// Renders a checked URL and returns the page's HTML after its scripts have run.
pub async fn render(url: &str, stealth: bool) -> Result<String, String> {
    let (reply, answer) = oneshot::channel();
    queue()?.send(Job { url: url.to_string(), stealth, reply }).map_err(|_| "The page renderer stopped.".to_string())?;
    match tokio::time::timeout(NAV_TIMEOUT + Duration::from_secs(15), answer).await {
        Ok(Ok(out)) => out,
        Ok(Err(_)) => Err("The page renderer stopped.".into()),
        Err(_) => Err("The page took too long to render.".into()),
    }
}
