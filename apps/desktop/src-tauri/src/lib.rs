use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

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
async fn select_workspace_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let result = app
        .dialog()
        .file()
        .set_parent(&main_window(&app)?)
        .blocking_pick_folder();
    Ok(result.map(|p| p.to_string()))
}

#[tauri::command]
fn get_workspace_path(state: tauri::State<'_, AppState>) -> Result<Option<String>, String> {
    let guard = state.workspace_path.lock().map_err(|e| e.to_string())?;
    Ok(guard.clone())
}

#[tauri::command]
fn set_workspace_path_state(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let mut guard = state.workspace_path.lock().map_err(|e| e.to_string())?;
    *guard = Some(path);
    Ok(())
}

#[tauri::command]
async fn set_workspace_path(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    sidecar: tauri::State<'_, sidecar::SidecarHandle>,
    path: String,
) -> Result<(), String> {
    {
        let mut guard = state.workspace_path.lock().map_err(|e| e.to_string())?;
        *guard = Some(path);
    }
    let _ = app;
    sidecar::stop_chat_sidecar(state, sidecar).await?;
    Ok(())
}

fn orion_global_dir() -> Result<PathBuf, String> {
    if let Ok(explicit) = std::env::var("ORION_GLOBAL_DIR") {
        return Ok(PathBuf::from(explicit));
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            return Ok(PathBuf::from(local_app_data).join("orion"));
        }
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            return Ok(PathBuf::from(user_profile).join(".orion"));
        }
        let home = dirs::home_dir().ok_or_else(|| "could not find home directory".to_string())?;
        return Ok(home.join(".orion"));
    }

    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir().ok_or_else(|| "could not find home directory".to_string())?;
        return Ok(home.join("Library").join("Application Support").join("orion"));
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
            return Ok(PathBuf::from(xdg).join("orion"));
        }
        let home = dirs::home_dir().ok_or_else(|| "could not find home directory".to_string())?;
        Ok(home.join(".orion"))
    }
}

fn projects_file(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(orion_global_dir()?.join("projects.json"))
}

#[tauri::command]
async fn load_projects(app: tauri::AppHandle) -> Result<String, String> {
    let path = projects_file(&app)?;
    if !path.exists() {
        return Ok(r#"{"projects":[],"activeProjectId":null}"#.to_string());
    }
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_projects(app: tauri::AppHandle, payload: String) -> Result<(), String> {
    let path = projects_file(&app)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    tokio::fs::write(&path, payload)
        .await
        .map_err(|e| e.to_string())
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
            select_workspace_folder,
            get_workspace_path,
            set_workspace_path_state,
            set_workspace_path,
            load_projects,
            save_projects,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
