//! Signal: the console in a window. On desktop it stays alive in the tray so checks keep
//! running; on Android (first version) checks run while the app is open.
//! `main.rs` is the desktop entry point; Android starts at `run()` (mobile_entry_point).

mod doc;
mod fetch;
#[cfg(desktop)]
mod mcp;
mod page;
#[cfg(desktop)]
mod render;
mod search;

/// Obscura (V8) isn't built for Android: pages that need JavaScript are read without it there.
#[cfg(mobile)]
mod render {
    pub async fn render(_url: &str, _stealth: bool) -> Result<String, String> {
        Err("Pages that need JavaScript can't be read on this device yet.".into())
    }
}

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
#[cfg(desktop)]
use tauri::tray::TrayIconBuilder;
#[cfg(desktop)]
use tauri::{WindowEvent, Wry};
use tauri::{AppHandle, Emitter, Manager};

const TICK: Duration = Duration::from_secs(60);

// Mirrors the console's "Automatic checks" setting so the tray can label its toggle.
static CHECKS_ON: AtomicBool = AtomicBool::new(true);

#[cfg(desktop)]
struct TrayItems {
    pause: MenuItem<Wry>,
}

#[cfg(desktop)]
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg(desktop)]
fn pause_label(on: bool) -> &'static str {
    if on { "Pause checks" } else { "Resume checks" }
}

#[tauri::command]
async fn fetch_url(req: fetch::FetchReq) -> fetch::FetchRes {
    let started = std::time::Instant::now();
    let url = req.url().to_string();
    let res = fetch::fetch_url(req).await;
    eprintln!("fetch {} {}ms {}", res.summary(), started.elapsed().as_millis(), url);
    res
}

#[tauri::command]
async fn search_web(query: String, site: Option<String>, count: Option<usize>) -> search::SearchOut {
    let out = search::search(&query, site.as_deref(), count.unwrap_or(8)).await;
    eprintln!("search {:?} -> {} results ({})", query, out.results.len(), out.notes.join("; "));
    out
}

#[tauri::command]
async fn read_page(url: String) -> page::PageOut {
    let out = page::read_page(&url, true).await;
    eprintln!("read_page {} {} {}b {}", if out.ok { "ok" } else { "refused" }, out.engine, out.text.len(), url);
    out
}

/// Search providers for the Research page. Keys never go back to the page, only whether one is set.
#[tauri::command]
fn search_settings() -> serde_json::Value {
    let s = search::load_settings();
    let used = search::usage_today();
    serde_json::json!({
        "stealth": s.stealth,
        "ddgsPath": search::ddgs_path().map(|p| p.display().to_string()),
        "providers": s.providers.iter().map(|p| serde_json::json!({
            "id": p.id, "on": p.on, "perDay": p.per_day,
            "hasKey": !p.key.trim().is_empty(),
            "url": p.url,
            "usedToday": used.get(&p.id).copied().unwrap_or(0)
        })).collect::<Vec<_>>()
    })
}

#[derive(serde::Deserialize)]
struct ProviderPatch {
    id: String,
    on: bool,
    #[serde(rename = "perDay")]
    per_day: u32,
    /// None keeps the saved key; "" removes it.
    key: Option<String>,
    /// None keeps the saved address.
    url: Option<String>,
}

/// Saves the providers in the order given (the order they are tried in).
#[tauri::command]
fn save_search_settings(providers: Vec<ProviderPatch>, stealth: Option<bool>) -> Result<serde_json::Value, String> {
    let old = search::load_settings();
    let mut next = Vec::new();
    for p in providers {
        let Some(prev) = old.providers.iter().find(|o| o.id == p.id) else { continue };
        next.push(search::Provider {
            id: p.id,
            on: p.on,
            per_day: p.per_day.min(10_000),
            key: p.key.map(|k| k.trim().to_string()).unwrap_or_else(|| prev.key.clone()),
            url: p.url.map(|u| u.trim().trim_end_matches('/').to_string()).filter(|u| u.is_empty() || u.starts_with("https://") || u.starts_with("http://")).unwrap_or_else(|| prev.url.clone()),
        });
    }
    for o in old.providers {
        if !next.iter().any(|n| n.id == o.id) {
            next.push(o);
        }
    }
    search::save_settings(&search::Settings { providers: next, stealth: stealth.unwrap_or(old.stealth) })?;
    Ok(search_settings())
}

/// A model API call for the console (ai.js), sent from here so endpoints that don't allow
/// browser requests (CORS), such as AWS Bedrock, work in the app. The endpoint is the one the
/// user set up; a local model server (Ollama, LM Studio) on this machine is allowed. Only the
/// console window can call this (capabilities/main.json); the headers carry the user's key and
/// are never logged.
#[tauri::command]
async fn model_request(url: String, headers: std::collections::HashMap<String, String>, body: String) -> Result<serde_json::Value, String> {
    let u = url::Url::parse(url.trim()).map_err(|_| "That model address isn't a valid link.".to_string())?;
    if u.scheme() != "https" && u.scheme() != "http" {
        return Err("The model address has to start with https:// (or http:// for a local server).".into());
    }
    if body.len() > 4 * 1024 * 1024 {
        return Err("That request is too large.".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| "Signal couldn't set up a connection.".to_string())?;
    let mut rb = client.post(u.as_str()).body(body);
    for (k, v) in headers {
        if k.len() < 100 && v.len() < 8192 && !v.contains(['\r', '\n']) {
            rb = rb.header(k, v);
        }
    }
    let res = rb.send().await.map_err(|e| {
        if e.is_timeout() { "timeout".to_string() } else { format!("Could not reach {}.", u.host_str().unwrap_or("the model server")) }
    })?;
    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    Ok(serde_json::json!({ "status": status, "text": text }))
}

/// Text from a CV or other document the user adds to their profile (Research page).
#[tauri::command]
async fn extract_document(name: String, data: String) -> Result<String, String> {
    doc::extract(&name, &data).await
}

/// Opens a web link in the user's own browser. The app window only ever shows the console.
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let u = url::Url::parse(url.trim()).map_err(|_| "That isn't a valid link.".to_string())?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err("Only web links can be opened.".into());
    }
    #[cfg(mobile)]
    {
        use tauri_plugin_opener::OpenerExt;
        return app.opener().open_url(u.as_str(), None::<&str>).map_err(|_| "Signal couldn't open your browser.".to_string());
    }
    #[cfg(desktop)]
    let _ = &app;
    #[cfg(target_os = "linux")]
    let cmd = ("xdg-open", vec![u.as_str()]);
    #[cfg(target_os = "macos")]
    let cmd = ("open", vec![u.as_str()]);
    #[cfg(target_os = "windows")]
    let cmd = ("rundll32", vec!["url.dll,FileProtocolHandler", u.as_str()]);
    #[cfg(desktop)]
    std::process::Command::new(cmd.0).args(cmd.1).spawn().map(|_| ()).map_err(|_| "Signal couldn't open your browser.".to_string())
}

#[cfg(feature = "test-hooks")]
#[tauri::command]
fn debug_log(msg: String) {
    eprintln!("page: {msg}");
}
#[cfg(not(feature = "test-hooks"))]
#[tauri::command]
fn debug_log(_msg: String) {}

/// The console tells us when automatic checks are switched on or off (tray label).
#[tauri::command]
fn set_checks_on(app: AppHandle, on: bool) {
    CHECKS_ON.store(on, Ordering::Relaxed);
    #[cfg(desktop)]
    if let Some(items) = app.try_state::<TrayItems>() {
        let _ = items.pause.set_text(pause_label(on));
    }
    #[cfg(mobile)]
    let _ = app;
}

/// A desktop notification for a new signal. Clicking it opens that signal in the window.
#[cfg(mobile)]
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String, signal_id: Option<String>) {
    use tauri_plugin_notification::NotificationExt;
    let _ = signal_id;
    let _ = app.notification().builder().title(title).body(body).show();
}

#[cfg(desktop)]
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String, signal_id: Option<String>) {
    std::thread::spawn(move || {
        let mut n = notify_rust::Notification::new();
        n.appname("Signal").summary(&title).body(&body).icon("app.studentos.signal");
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            n.action("default", "Open");
            if let Ok(handle) = n.show() {
                handle.wait_for_action(|action| {
                    if action == "default" {
                        show_main(&app);
                        let _ = app.emit("signal://open", signal_id.clone());
                    }
                });
            }
        }
        #[cfg(not(all(unix, not(target_os = "macos"))))]
        {
            let _ = (&app, &signal_id);
            let _ = n.show();
        }
    });
}

#[cfg(desktop)]
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Signal", true, None::<&str>)?;
    let check = MenuItem::with_id(app, "check", "Check now", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", pause_label(true), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &check, &pause, &sep, &quit])?;
    app.manage(TrayItems { pause });

    TrayIconBuilder::with_id("signal")
        .icon(app.default_window_icon().cloned().expect("app icon"))
        .tooltip("Signal")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "check" => {
                let _ = app.emit("signal://check-now", ());
            }
            "pause" => {
                let on = !CHECKS_ON.load(Ordering::Relaxed);
                let _ = app.emit("signal://set-checks", on);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `signal-desktop --mcp`: the research tools over stdio for MCP clients; no window.
    #[cfg(desktop)]
    if std::env::args().any(|a| a == "--mcp") {
        mcp::serve();
        return;
    }
    // WebKitGTK's DMA-BUF renderer fails on NVIDIA under X11 (a blank or torn window), so it is
    // turned off there. On Wayland it works and is faster (53 against 89 ms a frame measured),
    // so it stays on.
    #[cfg(target_os = "linux")]
    {
        let x11 = std::env::var("GDK_BACKEND").is_ok_and(|b| b.starts_with("x11")) || std::env::var_os("WAYLAND_DISPLAY").is_none();
        if x11 && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() && std::path::Path::new("/proc/driver/nvidia").exists() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }
    let builder = tauri::Builder::default();
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_notification::init()).plugin(tauri_plugin_opener::init());
    #[cfg(desktop)]
    let builder = builder
        // A second launch brings the running window forward instead of starting a second
        // scheduler that would check every source twice.
        // `signal-desktop --check-now` asks the running app to check without opening it.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|a| a == "--check-now") {
                let _ = app.emit("signal://check-now", ());
            } else if cfg!(feature = "test-hooks") && args.iter().any(|a| a == "--eval") {
                #[cfg(feature = "test-hooks")]
                if let (Some(i), Some(w)) = (args.iter().position(|a| a == "--eval"), app.get_webview_window("main")) {
                    if let Some(js) = args.get(i + 1) {
                        let _ = w.eval(js);
                    }
                    // `--top`: keep the window above others for a few seconds, for screenshots.
                    if args.iter().any(|a| a == "--top") {
                        let _ = w.show();
                        let _ = w.set_always_on_top(true);
                        let w2 = w.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_secs(4));
                            let _ = w2.set_always_on_top(false);
                        });
                    }
                }
            } else {
                show_main(app);
            }
        }))
        .on_window_event(|window, event| {
            // Closing the window hides it; checks keep running from the tray. Quit is in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        });
    builder
        .invoke_handler(tauri::generate_handler![fetch_url, set_checks_on, notify, search_web, read_page, search_settings, save_search_settings, open_external, debug_log, model_request, extract_document])
        .setup(|app| {
            if let Ok(dir) = app.path().app_config_dir() {
                search::set_config_dir(dir);
            }
            #[cfg(desktop)]
            build_tray(app)?;
            #[cfg(mobile)]
            {
                // Android 13+ asks once before an app may post notifications.
                use tauri_plugin_notification::NotificationExt;
                let _ = app.notification().request_permission();
            }
            // The console's own timers slow down or stop while the window is hidden, so the
            // app drives the schedule with a tick of its own.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut every = tokio::time::interval(TICK);
                every.tick().await;
                loop {
                    every.tick().await;
                    let _ = handle.emit("signal://tick", ());
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Signal");
}
