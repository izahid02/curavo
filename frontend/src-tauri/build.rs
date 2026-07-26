// Tauri build script — runs at compile time and generates the glue code that
// `tauri::generate_context!()` in main.rs depends on (from tauri.conf.json,
// capabilities, and icons).
fn main() {
    tauri_build::build()
}
