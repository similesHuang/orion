use std::sync::Mutex;
use tauri::Manager;

mod sidecar;

pub struct AppState {
    pub sidecar_port: Mutex<Option<u16>>,
    pub workspace_path: Mutex<Option<String>>,
}

fn main_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())
}

#[tauri::command]
fn minimize_window(app: tauri::AppHandle) -> Result<(), String> {
    main_window(&app)?.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
fn toggle_maximize_window(app: tauri::AppHandle) -> Result<bool, String> {
    let window = main_window(&app)?;
    if window.is_maximized().map_err(|e| e.to_string())? {
        window.unmaximize().map_err(|e| e.to_string())?;
        Ok(false)
    } else {
        window.maximize().map_err(|e| e.to_string())?;
        Ok(true)
    }
}

#[tauri::command]
fn close_window(app: tauri::AppHandle) -> Result<(), String> {
    main_window(&app)?.close().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_window_always_on_top(app: tauri::AppHandle, always_on_top: bool) -> Result<(), String> {
    main_window(&app)?
        .set_always_on_top(always_on_top)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_git_branch(path: String) -> Result<Option<String>, String> {
    let output = std::process::Command::new("git")
        .args(["-C", &path, "branch", "--show-current"])
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8(output.stdout)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()))
    } else {
        Ok(None)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .manage(AppState {
            sidecar_port: Mutex::new(None),
            workspace_path: Mutex::new(None),
        })
        .setup(|app| {
            sidecar::init_sidecar(app)?;
            Ok(())
        })
        .on_window_event(|app, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(sidecar) = app.try_state::<sidecar::SidecarHandle>() {
                    if let Some(child) = sidecar.child.lock().unwrap_or_else(|e| e.into_inner()).take() {
                        let _ = child.kill();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            sidecar::start_chat_sidecar,
            sidecar::stop_chat_sidecar,
            sidecar::get_sidecar_port,
            minimize_window,
            toggle_maximize_window,
            close_window,
            set_window_always_on_top,
            get_git_branch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
