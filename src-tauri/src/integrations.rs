use std::path::PathBuf;
use tauri::{AppHandle, Manager};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Return the platform target triple (e.g. "x86_64-unknown-linux-gnu").
fn target_triple() -> Result<String, String> {
    tauri::utils::platform::target_triple().map_err(|e| e.to_string())
}

/// Resolve the path to a bundled sidecar binary.
///
/// In dev mode the binary lives under `<cwd>/src-tauri/binaries/`.
/// In release mode it lives under `<resource_dir>/binaries/`.
///
/// On Windows the `.exe` extension is appended automatically.
fn sidecar_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let triple = target_triple()?;
    let filename = format!("{}-{}", name, triple);

    #[cfg(target_os = "windows")]
    let filename = format!("{}.exe", filename);

    #[cfg(debug_assertions)]
    {
        let _ = app; // not needed in dev mode
        let base = std::env::current_dir().map_err(|e| e.to_string())?;
        Ok(base.join("src-tauri").join("binaries").join(&filename))
    }

    #[cfg(not(debug_assertions))]
    {
        let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
        Ok(resource_dir.join("binaries").join(&filename))
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI commands
// ─────────────────────────────────────────────────────────────────────────────

/// Check whether the `linxiv` CLI is available on PATH.
#[tauri::command]
pub fn is_cli_installed() -> bool {
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("where")
        .arg("linxiv")
        .output();

    #[cfg(not(target_os = "windows"))]
    let result = std::process::Command::new("which")
        .arg("linxiv")
        .output();

    match result {
        Ok(output) => output.status.success(),
        Err(_) => false,
    }
}

/// Install the bundled `linxiv` CLI sidecar so it is accessible as `linxiv`
/// on the user's PATH.
///
/// - Linux/macOS: creates a symlink `~/.local/bin/linxiv` → binary path.
/// - Windows: creates a `.bat` shim in `%LOCALAPPDATA%\Programs\linxiv\` and
///   adds that directory to the user's PATH registry key.
#[tauri::command]
pub fn install_cli(app: AppHandle) -> Result<(), String> {
    let binary = sidecar_path(&app, "linxiv")?;

    #[cfg(not(target_os = "windows"))]
    {
        let home = dirs_home().ok_or("Could not determine home directory")?;
        let bin_dir = home.join(".local").join("bin");
        std::fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;
        let link = bin_dir.join("linxiv");
        // Remove stale symlink/file first so we can re-link.
        if link.exists() || link.symlink_metadata().is_ok() {
            std::fs::remove_file(&link).map_err(|e| e.to_string())?;
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&binary, &link).map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        let local_app_data = std::env::var("LOCALAPPDATA")
            .map_err(|_| "LOCALAPPDATA not set".to_string())?;
        let dir = PathBuf::from(local_app_data)
            .join("Programs")
            .join("linxiv");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

        let bat = dir.join("linxiv.bat");
        let binary_str = binary.to_string_lossy();
        let content = format!("@echo off\n\"{binary_str}\" %*\n");
        std::fs::write(&bat, content).map_err(|e| e.to_string())?;

        windows_path_add(dir.to_string_lossy().as_ref())?;
        Ok(())
    }
}

/// Remove the `linxiv` CLI shim/symlink installed by `install_cli`.
#[tauri::command]
pub fn uninstall_cli() -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let home = dirs_home().ok_or("Could not determine home directory")?;
        let link = home.join(".local").join("bin").join("linxiv");
        if link.exists() || link.symlink_metadata().is_ok() {
            std::fs::remove_file(&link).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        let local_app_data = std::env::var("LOCALAPPDATA")
            .map_err(|_| "LOCALAPPDATA not set".to_string())?;
        let dir = PathBuf::from(local_app_data)
            .join("Programs")
            .join("linxiv");
        let bat = dir.join("linxiv.bat");
        if bat.exists() {
            std::fs::remove_file(&bat).map_err(|e| e.to_string())?;
        }
        windows_path_remove(dir.to_string_lossy().as_ref())?;
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP types & helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Status of a supported MCP client on this machine.
// NOTE: The struct is intentionally named `MpcClientStatus` (not `Mcp…`) to
// match the identifier agreed with the frontend.
#[derive(serde::Serialize)]
pub struct MpcClientStatus {
    pub id: String,
    pub name: String,
    /// `true` when linxiv is already registered in the client's config file.
    pub installed: bool,
    /// `true` when the client application appears to be present on this machine.
    pub available: bool,
}

/// Return the path to the MCP config file for a given client.
fn mcp_config_path(client_id: &str) -> Result<PathBuf, String> {
    let home = dirs_home().ok_or("Could not determine home directory")?;

    match client_id {
        "claude" => {
            #[cfg(target_os = "linux")]
            return Ok(home.join(".config").join("Claude").join("claude_desktop_config.json"));

            #[cfg(target_os = "macos")]
            return Ok(home
                .join("Library")
                .join("Application Support")
                .join("Claude")
                .join("claude_desktop_config.json"));

            #[cfg(target_os = "windows")]
            {
                let appdata = std::env::var("APPDATA")
                    .map_err(|_| "APPDATA not set".to_string())?;
                return Ok(PathBuf::from(appdata)
                    .join("Claude")
                    .join("claude_desktop_config.json"));
            }

            #[cfg(not(any(
                target_os = "linux",
                target_os = "macos",
                target_os = "windows"
            )))]
            Err(format!("Unsupported OS for client '{}'", client_id))
        }
        "cursor" => {
            #[cfg(not(target_os = "windows"))]
            return Ok(home.join(".cursor").join("mcp.json"));

            #[cfg(target_os = "windows")]
            {
                let appdata = std::env::var("APPDATA")
                    .map_err(|_| "APPDATA not set".to_string())?;
                return Ok(PathBuf::from(appdata).join("Cursor").join("mcp.json"));
            }
        }
        "antigravity" => {
            #[cfg(not(target_os = "windows"))]
            return Ok(home
                .join(".codeium")
                .join("antigravity")
                .join("mcp_config.json"));

            #[cfg(target_os = "windows")]
            {
                let appdata = std::env::var("APPDATA")
                    .map_err(|_| "APPDATA not set".to_string())?;
                return Ok(PathBuf::from(appdata)
                    .join("Codeium")
                    .join("Antigravity")
                    .join("mcp_config.json"));
            }
        }
        "claude-code" => Ok(home.join(".claude.json")),
        _ => Err(format!("Unknown MCP client: {}", client_id)),
    }
}

/// Return the config *directory* for a client (used to test whether the app is
/// installed without needing to find the client binary).
fn mcp_config_dir(client_id: &str) -> Option<PathBuf> {
    mcp_config_path(client_id)
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

/// Read the MCP JSON config file (or return an empty object if it doesn't
/// exist), then return the parsed value.
fn read_mcp_config(path: &PathBuf) -> Result<serde_json::Value, String> {
    if path.exists() {
        let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        serde_json::from_str(&text).map_err(|e| e.to_string())
    } else {
        Ok(serde_json::json!({}))
    }
}

/// Write a JSON value back to disk (pretty-printed).
fn write_mcp_config(path: &PathBuf, value: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

/// Return `true` when a client application appears to be present on this machine.
///
/// Most clients are detected by checking whether their config directory exists.
/// Claude Code is detected by looking for the `claude` binary on PATH, because
/// its config file lives directly in `~` (which always exists).
fn is_client_available(client_id: &str) -> bool {
    if client_id == "claude-code" {
        #[cfg(target_os = "windows")]
        let result = std::process::Command::new("where").arg("claude").output();
        #[cfg(not(target_os = "windows"))]
        let result = std::process::Command::new("which").arg("claude").output();
        return matches!(result, Ok(o) if o.status.success());
    }
    mcp_config_dir(client_id)
        .map(|d| d.exists())
        .unwrap_or(false)
}

/// Return `true` when a config file contains `mcpServers.linxiv`.
fn config_has_linxiv(path: &PathBuf) -> bool {
    if !path.exists() {
        return false;
    }
    match read_mcp_config(path) {
        Ok(v) => v
            .get("mcpServers")
            .and_then(|s| s.get("linxiv"))
            .is_some(),
        Err(_) => false,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP commands
// ─────────────────────────────────────────────────────────────────────────────

/// Return all supported MCP clients with their current install/available status.
#[tauri::command]
pub fn list_mcp_clients() -> Vec<MpcClientStatus> {
    let clients = [
        ("claude", "Claude Desktop"),
        ("claude-code", "Claude Code"),
        ("cursor", "Cursor"),
        ("antigravity", "Antigravity"),
    ];

    clients
        .iter()
        .map(|(id, name)| {
            let config_path = mcp_config_path(id).ok();
            let installed = config_path
                .as_ref()
                .map(config_has_linxiv)
                .unwrap_or(false);
            let available = is_client_available(id);

            MpcClientStatus {
                id: id.to_string(),
                name: name.to_string(),
                installed,
                available,
            }
        })
        .collect()
}

/// Register linxiv's MCP server in a client's config file.
///
/// Existing `mcpServers` entries are preserved; only the `"linxiv"` key is
/// added or overwritten.
#[tauri::command]
pub fn install_mcp(app: AppHandle, client_id: String) -> Result<(), String> {
    let binary = sidecar_path(&app, "linxiv-mcp")?;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    let config_path = mcp_config_path(&client_id)?;
    let mut config = read_mcp_config(&config_path)?;

    let servers = config
        .as_object_mut()
        .ok_or("Config root is not a JSON object")?
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));

    let servers_obj = servers
        .as_object_mut()
        .ok_or("mcpServers is not a JSON object")?;

    servers_obj.insert(
        "linxiv".to_string(),
        serde_json::json!({
            "command": binary.to_string_lossy(),
            "args": [],
            "env": {
                "LINXIV_DATA_DIR": data_dir.to_string_lossy()
            }
        }),
    );

    write_mcp_config(&config_path, &config)
}

/// Remove the `"linxiv"` entry from a client's `mcpServers` config.
/// Succeeds silently if the file or key does not exist.
#[tauri::command]
pub fn uninstall_mcp(client_id: String) -> Result<(), String> {
    let config_path = mcp_config_path(&client_id)?;

    if !config_path.exists() {
        return Ok(());
    }

    let mut config = read_mcp_config(&config_path)?;

    if let Some(servers) = config
        .as_object_mut()
        .and_then(|o| o.get_mut("mcpServers"))
        .and_then(|s| s.as_object_mut())
    {
        servers.remove("linxiv");
    }

    write_mcp_config(&config_path, &config)
}

/// Check whether the `"linxiv"` MCP entry exists in a client's config file.
#[tauri::command]
pub fn is_mcp_installed(client_id: String) -> bool {
    match mcp_config_path(&client_id) {
        Ok(p) => config_has_linxiv(&p),
        Err(_) => false,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform utilities
// ─────────────────────────────────────────────────────────────────────────────

/// Cross-platform home directory lookup without pulling in the `dirs` crate.
fn dirs_home() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE")
            .ok()
            .map(PathBuf::from)
            .or_else(|| {
                let drive = std::env::var("HOMEDRIVE").ok()?;
                let path = std::env::var("HOMEPATH").ok()?;
                Some(PathBuf::from(format!("{}{}", drive, path)))
            })
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows PATH registry helpers (compiled only on Windows)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn windows_path_add(dir: &str) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let env = hkcu
        .open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)
        .map_err(|e| e.to_string())?;

    let current_path: String = env.get_value("Path").unwrap_or_default();

    // Only append if the directory is not already on PATH.
    let entries: Vec<&str> = current_path.split(';').collect();
    if entries.iter().any(|e| e.eq_ignore_ascii_case(dir)) {
        return Ok(());
    }

    let new_path = if current_path.is_empty() {
        dir.to_string()
    } else {
        format!("{};{}", current_path, dir)
    };

    // NOTE: Running applications will not see this change until they restart;
    // broadcasting WM_SETTINGCHANGE would notify them but requires a Win32 call.
    env.set_value("Path", &new_path).map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
fn windows_path_remove(dir: &str) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let env = hkcu
        .open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)
        .map_err(|e| e.to_string())?;

    let current_path: String = env.get_value("Path").unwrap_or_default();

    let new_path: Vec<&str> = current_path
        .split(';')
        .filter(|e| !e.eq_ignore_ascii_case(dir))
        .collect();

    env.set_value("Path", &new_path.join(";"))
        .map_err(|e| e.to_string())
}
