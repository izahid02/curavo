// Prevents a second console window from opening behind the app on Windows
// release builds.  Debug builds keep the console so println!/eprintln! show.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use tauri::{Emitter, Manager};
use tauri_plugin_shell::ShellExt;

/// Locate the AppData/HCC folder that the Python backend writes port.txt into.
/// This MUST match get_app_data_dir() in backend/main_desktop.py.
fn hcc_data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata).join("HCC");
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("HCC");
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(".local").join("share").join("HCC");
        }
    }
    PathBuf::from("HCC")
}

/// Read the port the backend actually bound to.  Returns None until the
/// backend has started and written the file.
fn read_backend_port() -> Option<u16> {
    let path = hcc_data_dir().join("port.txt");
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // 1) Spawn the Python backend as a bundled sidecar process.
            let sidecar_command = handle
                .shell()
                .sidecar("hcc-backend")
                .expect("Failed to find hcc-backend sidecar");

            let (_rx, _child) = sidecar_command
                .spawn()
                .expect("Failed to spawn hcc-backend");

            // 2) In a background thread, poll /health until the backend answers
            //    (max ~30s), then tell the frontend which port to talk to.
            thread::spawn(move || {
                let client = reqwest::blocking::Client::builder()
                    .timeout(Duration::from_secs(2))
                    .build()
                    .unwrap();

                let mut attempts = 0;
                loop {
                    thread::sleep(Duration::from_millis(500));
                    attempts += 1;

                    // The backend prefers 8000 but may fall back; default to
                    // 8000 until port.txt exists so the first probes still work.
                    let port = read_backend_port().unwrap_or(8000);
                    let url = format!("http://127.0.0.1:{port}/health");

                    if let Ok(resp) = client.get(&url).send() {
                        if resp.status().is_success() {
                            println!("Backend ready on port {port} after {}ms", attempts * 500);
                            if let Some(win) = handle.get_webview_window("main") {
                                // Inject the resolved port so lib/api.js points
                                // at the right backend address even if it isn't 8000.
                                let _ = win.eval(&format!("window.__HCC_PORT__ = {port};"));
                                // Fire the event the splash screen is waiting on.
                                let _ = win.emit("backend-ready", port);
                            }
                            break;
                        }
                    }

                    if attempts >= 60 {
                        eprintln!("Backend failed to start after 30s");
                        handle.exit(1);
                        break;
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
