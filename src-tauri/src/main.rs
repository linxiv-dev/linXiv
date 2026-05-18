#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod integrations;

use std::time::Duration;
use tauri::Manager;

fn wait_for_api(max_attempts: u32) -> bool {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Resolve OS app data dir — Python stores DB, PDFs, settings here
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let data_dir_str = data_dir.to_string_lossy().to_string();

            // Dev: spawn via uv (source)
            #[cfg(debug_assertions)]
            {
                let project_dir = std::env::current_dir().unwrap_or_default();
                let _ = std::process::Command::new("uv")
                    .args(["run", "python", "-m", "api"])
                    .current_dir(&project_dir)
                    .env("CORS_ORIGINS", "tauri://localhost,https://tauri.localhost,http://localhost:5173")
                    .env("LINXIV_DATA_DIR", &data_dir_str)
                    .spawn();
            }

            // Release: spawn PyInstaller sidecar binary
            #[cfg(not(debug_assertions))]
            {
                use tauri_plugin_shell::ShellExt;
                if let Ok(cmd) = app.shell().sidecar("linxiv-api") {
                    let _ = cmd
                        .env("LINXIV_DATA_DIR", &data_dir_str)
                        .env("CORS_ORIGINS", "tauri://localhost,https://tauri.localhost")
                        .spawn();
                }
            }

            let api_ready = wait_for_api(20);
            let window = app.get_webview_window("main").unwrap();
            if !api_ready {
                let _ = window.set_title("linXiv — API failed to start");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            integrations::is_cli_installed,
            integrations::install_cli,
            integrations::uninstall_cli,
            integrations::list_mcp_clients,
            integrations::install_mcp,
            integrations::uninstall_mcp,
            integrations::is_mcp_installed,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
