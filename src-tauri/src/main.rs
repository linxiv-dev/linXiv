#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use linxiv_app::p2p_config;
use linxiv_app::route::share::ShareState;
use linxiv_app::state::AppState;
use linxiv_app::{commands, integrations, protocol, remote_backend, route};

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use tracing_subscriber::EnvFilter;

/// Open a locally-stored PDF in the OS default viewer.
///
/// Reachable over IPC, so re-validate before handing the path to the OS: it
/// must be an absolute path to an existing `.pdf` file. Opened via the Rust
/// opener API (not scope-gated) — the per-OS PDF dir defeats the JS plugin's
/// static capability glob.
#[tauri::command]
fn open_pdf_in_system(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let candidate = std::path::Path::new(&path);
    if !candidate.is_absolute() {
        return Err("Refusing to open a non-absolute path".to_string());
    }
    if !candidate.is_file() {
        return Err("PDF file not found on disk".to_string());
    }
    if !candidate
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
    {
        return Err("Refusing to open a non-PDF file in the system viewer".to_string());
    }
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("System viewer could not open the PDF: {e}"))
}

/// Where the webview's (0,0) sits inside the toplevel window, in logical px —
/// on Linux (CSD) the toplevel origin includes titlebar/shadow margins the
/// webview's clientX/Y know nothing about. Measured per popup (margins vanish
/// when maximized). Must stay a sync command — gtk requires the GTK main thread.
#[cfg(target_os = "linux")]
#[tauri::command]
fn menu_popup_offset(window: tauri::Window) -> (i32, i32) {
    use gtk::prelude::*;
    window
        .gtk_window()
        .ok()
        .and_then(|w| w.child()?.translate_coordinates(&w, 0, 0))
        .unwrap_or((0, 0))
}

/// Elsewhere popup positions are already client-area-relative.
#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn menu_popup_offset() -> (i32, i32) {
    (0, 0)
}

fn main() {
    // ponytail: WebKit/Mesa shutdown race (libEGL __eglFini frees EGL state under
    // a Skia GPU painting thread's TLS destructor) segfaults WebKitWebProcess on
    // close/reset. Set before the web process spawns; drop once fixed upstream.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_SKIA_GPU_PAINTING_THREADS").is_none() {
        std::env::set_var("WEBKIT_SKIA_GPU_PAINTING_THREADS", "0");
    }
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    tauri::Builder::default()
        // Prevent a second linXiv process from opening shared resources such as
        // the P2P blob database. Focus the existing window instead.
        .plugin(tauri_plugin_single_instance::init(
            |app, _args, _cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
             },
        ))
        .plugin(tauri_plugin_deep_link::init())
        // linxiv:// serves local and proxied PDF bytes to the webview —
        // invoke() can't stream binary into react-pdf or an `<iframe src>`.
        .register_asynchronous_uri_scheme_protocol(protocol::SCHEME, protocol::handler)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_texbrain::init())
        .setup(|app| {
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
              {
               use tauri_plugin_deep_link::DeepLinkExt;
               app.deep_link().register_all()?;
              }
            // In-process backend: open the DB once and manage it. The webview
            // reaches linxiv-core through the invoke commands below plus the
            // linxiv:// scheme — no sidecar, no HTTP hop, nothing to reap.
            app.manage(AppState::new().map_err(|e| e.to_string())?);
            // Background TeX full-text indexing, one paper at a time. Idles
            // unless `full_text_worker_enabled` is on (Settings → Library).
            commands::spawn_full_text_worker(app.handle().clone());
            // Quarantined CRDT "shared projects" store, managed beside AppState
            // (never a field of it), resolved by every p2p-touching command.
            // The Endpoint bind is async: block on it during setup so the
            // network arms have a live node from the first request. Resolve the
            // DEK first — keychain access is sync, never call it from async.
            let dek = p2p_config::p2p_dek();
            let (share_state, node_bound) =
                tauri::async_runtime::block_on(route::share::startup_share_state(dek))
                    .map_err(|e| e.to_string())?;
            app.manage(share_state);
            // Remote Query Mode client half: cached outbound connections,
            // one per registered backend (dials reuse the share endpoint).
            app.manage(remote_backend::RemoteState::default());
            // `mark_sync_started` also guards the relay-reconnect route's spawn, so a
            // node that only comes up later (e.g. relay was fixed via "Save & Reconnect")
            // still gets exactly one interval-sync loop.
            if node_bound && app.state::<ShareState>().mark_sync_started() {
                // Share sync: one pass now, then on nudge or 5 min.
                commands::spawn_interval_sync(app.handle().clone());
            }
            // Unconditional, unlike the sync above: undo needs no p2p node.
            commands::spawn_journal_loop(app.handle().clone());
            // Point the pdfium loader at the libpdfium bundled under the app
            // resources (tauri.conf.json `bundle.resources` maps it into pdfium/).
            if std::env::var_os("LINXIV_PDFIUM_LIB").is_none() {
                let lib_name = if cfg!(target_os = "windows") {
                    "pdfium.dll"
                } else if cfg!(target_os = "macos") {
                    "libpdfium.dylib"
                } else {
                    "libpdfium.so"
                };
                if let Ok(dir) = app.path().resource_dir() {
                    let lib = dir.join("pdfium").join(lib_name);
                    let lib_bin = dir.join("pdfium").join("bin").join(lib_name);
                    if lib.is_file() {
                        std::env::set_var("LINXIV_PDFIUM_LIB", lib);
                    } else if lib_bin.is_file() {
                        std::env::set_var("LINXIV_PDFIUM_LIB", lib_bin);
                    } else if !cfg!(debug_assertions) {
                        eprintln!(
                            "linxiv: bundled pdfium lib not found at {} or {}; PDF metadata extraction will be degraded",
                            lib.display(),
                            lib_bin.display()
                        );
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::api,
            commands::share_api,
            remote_backend::remote_backends_list,
            remote_backend::remote_backend_add,
            remote_backend::remote_backend_remove,
            remote_backend::api_remote,
            remote_backend::remote_pdf,
            remote_backend::remote_member_code,
            open_pdf_in_system,
            menu_popup_offset,
            integrations::is_cli_installed,
            integrations::install_cli,
            integrations::uninstall_cli,
            integrations::list_mcp_clients,
            integrations::install_mcp,
            integrations::uninstall_mcp,
            integrations::is_mcp_installed,
            integrations::get_linux_package_kind,
            integrations::apply_linux_package_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Explicit async teardown of the iroh endpoint + router on exit; Drop
            // alone can't run the async close.
            if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
                if app.try_state::<ShareState>().is_none() {
                    return;
                }
                // Restart can't be prevented: tear down inline.
                if code == Some(tauri::RESTART_EXIT_CODE) {
                    let share = app.state::<ShareState>();
                    tauri::async_runtime::block_on(shutdown_share(&share));
                    return;
                }
                // Blocking here stalls the main loop, so the closed window stays
                // on screen until teardown ends. Tear down off-thread, then
                // re-request exit; the latch lets that second request through.
                static TEARDOWN_STARTED: AtomicBool = AtomicBool::new(false);
                if TEARDOWN_STARTED.swap(true, Ordering::SeqCst) {
                    return;
                }
                api.prevent_exit();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    shutdown_share(&app.state::<ShareState>()).await;
                    app.exit(code.unwrap_or(0));
                });
            }
        });
}

/// Bounded share teardown: Router::shutdown can wait on draining handlers, so
/// cap it and let exit proceed if it overruns.
async fn shutdown_share(share: &ShareState) {
    match tokio::time::timeout(std::time::Duration::from_secs(5), share.shutdown()).await {
        Ok(Err(e)) => eprintln!("share node shutdown error: {e}"),
        Err(_) => eprintln!("share node shutdown timed out; abandoning"),
        Ok(Ok(())) => {}
    }
}
