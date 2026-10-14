// The desktop app's entry: one window around the frontend, with the dialog and fs plugins, and the opener for the https
// links in the Docs. What the page may call is limited by capabilities/default.json.

// No console window behind the app in a release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running Dialect");
}
