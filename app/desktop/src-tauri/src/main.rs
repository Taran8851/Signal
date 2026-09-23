// Signal desktop entry point. Everything lives in lib.rs, which Android starts directly.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    signal_lib::run()
}
