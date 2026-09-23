// Signal desktop entry point. Everything lives in lib.rs, which Android starts directly; only the
// Obscura page renderer is here, because V8 can't go into the library's Android build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod render_obscura;

fn main() {
    signal_lib::render::set_renderer(|url, stealth| Box::pin(async move { render_obscura::render(&url, stealth).await }));
    signal_lib::run()
}
