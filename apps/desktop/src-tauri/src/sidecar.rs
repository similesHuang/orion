use crate::AppState;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::path::BaseDirectory;
use tauri::{command, Manager, State};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::sleep;

async fn sidecar_is_alive(port: u16) -> bool {
    // Probe the root endpoint and verify the response actually comes from our
    // sidecar. A plain "HTTP/1.1 200" check is too weak: if the selected port
    // is occupied by the Vite dev server (or any other HTTP service) we would
    // falsely report the sidecar as ready.
    let request = format!(
        "GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
        port
    );
    let mut stream = match TcpStream::connect(("127.0.0.1", port)).await {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    if stream.write_all(request.as_bytes()).await.is_err() {
        return false;
    }
    let _ = stream.shutdown().await;
    let mut buffer = [0u8; 256];
    match stream.read(&mut buffer).await {
        Ok(n) if n >= 12 => {
            let text = String::from_utf8_lossy(&buffer[..n]);
            text.contains("HTTP/1.1 200") && text.contains("Orion desktop sidecar")
        }
        _ => false,
    }
}

pub struct SidecarHandle {
    pub child: Mutex<Option<tauri_plugin_shell::process::CommandChild>>,
}

fn dist_marker() -> PathBuf {
    Path::new("dist").join("sidecar").join("chat-sidecar.js")
}

fn find_sidecar_script_from_exe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    for ancestor in exe.ancestors().skip(1) {
        let candidate = ancestor.join(dist_marker());
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn find_sidecar_script_from_cwd() -> Option<PathBuf> {
    if let Ok(cwd) = std::env::current_dir() {
        for root in [cwd.clone(), cwd.parent().map(Path::to_path_buf).unwrap_or_default()] {
            if root.as_os_str().is_empty() {
                continue;
            }
            let candidate = root.join(dist_marker());
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

fn resolve_sidecar_script(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // 1. Packaged app: resources bundled by tauri.conf.json bundle.resources.
    if let Ok(resource_path) = app.path().resolve("dist/sidecar/chat-sidecar.js", BaseDirectory::Resource) {
        if resource_path.exists() {
            return Ok(resource_path);
        }
    }

    // 2. Dev mode: walk up from the executable (src-tauri/target/debug/orion -> src-tauri).
    if let Some(path) = find_sidecar_script_from_exe() {
        return Ok(path);
    }

    // 3. Fallback: current working directory (e.g. when invoked from project root).
    if let Some(path) = find_sidecar_script_from_cwd() {
        return Ok(path);
    }

    Err("could not find dist/sidecar/chat-sidecar.js in resources, executable ancestors, or current directory".to_string())
}

fn find_free_port() -> Result<u16, String> {
    // Try a handful of ports to reduce the chance that the selected port is taken
    // between releasing the probe listener and the sidecar binding it.
    // Skip the fixed Vite dev server port (5173) used by the frontend so the
    // sidecar never races with it.
    for _ in 0..10 {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        drop(listener);
        if port == 5173 {
            continue;
        }
        // Quick verification that the port is still free.
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    Err("could not find a free port".to_string())
}

fn clear_sidecar_state(state: &AppState, sidecar: &SidecarHandle) {
    let _ = state.sidecar_port.lock().map(|mut guard| *guard = None);
    let _ = sidecar.child.lock().map(|mut guard| *guard = None);
}

#[command]
pub async fn start_chat_sidecar(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    sidecar: State<'_, SidecarHandle>,
) -> Result<u16, String> {
    let existing_port = {
        let guard = state.sidecar_port.lock().map_err(|e| e.to_string())?;
        *guard
    };
    if let Some(port) = existing_port {
        if sidecar_is_alive(port).await {
            return Ok(port);
        }
    }
    // Either no port was recorded or the old sidecar is no longer alive: clear state and respawn.
    clear_sidecar_state(&state, &sidecar);

    let port = find_free_port()?;
    let script = resolve_sidecar_script(&app)?;
    let root = script
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| "invalid sidecar script path".to_string())?;

    let workspace_path = {
        let guard = state.workspace_path.lock().map_err(|e| e.to_string())?;
        guard.clone().unwrap_or_else(|| root.to_string_lossy().to_string())
    };

    let mut cmd = app
        .shell()
        .command("node")
        .args([script.to_string_lossy().to_string()])
        .current_dir(&root)
        .env("WEB_PORT", port.to_string())
        .env("TAURI_SIDECHAT", "1");
    cmd = cmd.env("ORION_WORKSPACE_DIR", workspace_path);

    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar: {e}"))?;

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    println!("[sidecar] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Error(e) => {
                    eprintln!("[sidecar] error: {e}");
                }
                CommandEvent::Terminated(payload) => {
                    println!("[sidecar] terminated: {payload:?}");
                    if let (Some(state), Some(sidecar)) = (
                        app_clone.try_state::<AppState>(),
                        app_clone.try_state::<SidecarHandle>(),
                    ) {
                        clear_sidecar_state(&state, &sidecar);
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    // Wait for the sidecar HTTP server to actually accept connections before returning.
    let ready = wait_until_sidecar_ready(port).await;
    if !ready {
        let _ = child.kill();
        return Err(format!(
            "sidecar started on port {port} but did not become ready within 20 seconds; check [sidecar] logs above"
        ));
    }

    *sidecar.child.lock().map_err(|e| e.to_string())? = Some(child);
    *state.sidecar_port.lock().map_err(|e| e.to_string())? = Some(port);
    Ok(port)
}

async fn wait_until_sidecar_ready(port: u16) -> bool {
    for _ in 0..80 {
        if sidecar_is_alive(port).await {
            return true;
        }
        sleep(Duration::from_millis(250)).await;
    }
    false
}

#[command]
pub async fn stop_chat_sidecar(
    state: State<'_, AppState>,
    sidecar: State<'_, SidecarHandle>,
) -> Result<(), String> {
    let child = {
        let mut guard = sidecar.child.lock().map_err(|e| e.to_string())?;
        guard.take()
    };
    if let Some(child) = child {
        let _ = child.kill();
        // Allow a brief moment for the OS to reap the process before a new spawn.
        sleep(Duration::from_millis(300)).await;
    }
    *state.sidecar_port.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

#[command]
pub fn get_sidecar_port(state: State<'_, AppState>) -> Result<Option<u16>, String> {
    let guard = state.sidecar_port.lock().map_err(|e| e.to_string())?;
    Ok(*guard)
}

pub fn init_sidecar(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(SidecarHandle {
        child: Mutex::new(None),
    });
    Ok(())
}
