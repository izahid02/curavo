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

/// Append a line to AppData/HCC/tauri.log.
///
/// Release builds set windows_subsystem = "windows", which means the process
/// has NO console — every println!/eprintln! in this file is silently thrown
/// away on a real user's machine.  That is why a failed startup produced no
/// clues at all.  Writing to a file is the only way to see what happened.
fn log_line(msg: &str) {
    use std::io::Write;
    // Seconds since boot-of-epoch: enough to measure the startup sequence
    // without pulling in a date-formatting crate.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let dir = hcc_data_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("tauri.log"))
    {
        let _ = writeln!(f, "[{stamp}] {msg}");
    }
    println!("{msg}"); // still useful in a debug build, harmless in release
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

            log_line("Tauri: sidecar hcc-backend spawned");

            // 2) In a background thread, poll /health until the backend answers
            //    (max ~30s), then tell the frontend which port to talk to.
            thread::spawn(move || {
                let client = reqwest::blocking::Client::builder()
                    .timeout(Duration::from_secs(2))
                    .build()
                    .unwrap();

                log_line("Tauri: waiting for backend /health");

                let mut attempts = 0;
                let ready_port = loop {
                    thread::sleep(Duration::from_millis(500));
                    attempts += 1;

                    // The backend prefers 8000 but may fall back; default to
                    // 8000 until port.txt exists so the first probes still work.
                    let port = read_backend_port().unwrap_or(8000);
                    let url = format!("http://127.0.0.1:{port}/health");

                    if let Ok(resp) = client.get(&url).send() {
                        if resp.status().is_success() {
                            log_line(&format!(
                                "Tauri: backend ready on port {port} after {}ms",
                                attempts * 500
                            ));
                            break Some(port);
                        }
                    }

                    // 120 attempts x 500ms = 60s.  Windows machines (slower
                    // disks, antivirus scanning a freshly-unpacked .exe) can
                    // take far longer than a Mac to get the first request out.
                    if attempts >= 120 {
                        log_line("Tauri: backend failed to answer /health after 60s");
                        break None;
                    }
                };

                let Some(port) = ready_port else {
                    // Give the log a moment to flush, then quit rather than
                    // leaving the user staring at a splash screen forever.
                    thread::sleep(Duration::from_secs(1));
                    handle.exit(1);
                    return;
                };

                // Keep ANNOUNCING the port rather than firing once.
                //
                // This is the actual splash-screen-hang fix.  Tauri events are
                // not buffered: an event emitted before React has run its
                // useEffect is delivered to nobody and is gone forever.  The
                // same applies to eval() — if the document is still loading,
                // window.__HCC_PORT__ is set on a page that is about to be
                // replaced.  Since the backend usually wins this race, the app
                // hung on "Almost ready..." indefinitely.
                //
                // Re-emitting every 500ms for 30s means the listener gets the
                // event within half a second of mounting, no matter who wins.
                for _ in 0..60 {
                    if let Some(win) = handle.get_webview_window("main") {
                        // Inject the resolved port so lib/api.js points at the
                        // right backend address even if it isn't 8000.
                        let _ = win.eval(&format!("window.__HCC_PORT__ = {port};"));
                    }
                    // handle.emit broadcasts to every webview, so this works
                    // even if the window label is ever renamed from "main".
                    let _ = handle.emit("backend-ready", port);
                    thread::sleep(Duration::from_millis(500));
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
