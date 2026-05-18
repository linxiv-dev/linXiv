// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::Duration;
use tauri::Manager;

#[cfg(debug_assertions)]
fn spawn_api_server() -> Option<std::process::Child> {
    let child = std::process::Command::new("uv")
        .args(["run", "python", "-m", "api"])
        .env("CORS_ORIGINS", "tauri://localhost,https://tauri.localhost,http://localhost:5173")
        .current_dir(
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                .unwrap_or_default(),
        )
        .spawn()
        .ok();
    child
}

#[cfg(not(debug_assertions))]
fn spawn_api_server() -> Option<std::process::Child> {
    None // production: sidecar handled by Tauri
}

fn wait_for_api(max_attempts: u32) -> bool {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap_or_default();
    for i in 0..max_attempts {
        if let Ok(resp) = client.get("http://127.0.0.1:8000/api/health").send() {
            if resp.status().is_success() {
                return true;
            }
        }
        if i < max_attempts - 1 {
            std::thread::sleep(Duration::from_millis(500 + (i as u64 * 200)));
        }
    }
    false
}

fn main() {
    let _server = spawn_api_server();

    // Give the server time to start, then open the window
    let api_ready = wait_for_api(20);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            let window = app.get_webview_window("main").unwrap();
            if !api_ready {
                // API didn't start — show error in title
                let _ = window.set_title("linXiv — API failed to start");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
