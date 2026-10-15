// The desktop app's entry: one window around the frontend, with the dialog and fs plugins, the opener for the https
// links in the Docs, and an icon in the notification area. What the page may call is limited by
// capabilities/default.json; the tray needs nothing there, as its menu runs here.

// No console window behind the app in a release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

/// The event the page listens for to open its New Tab picker (src/main.tsx).
const NEW_TAB_EVENT: &str = "tray-new-tab";

/// Brings the window back: out of the taskbar if minimised, and to the front.
fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The icon in the notification area, with its menu. A desktop without one (a CI runner's session, a shell other than
/// Explorer) fails to make it: the app then runs without it, as closing the window quits the app anyway.
fn tray(app: &tauri::App) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "show", "Show Dialect", true, None::<&str>)?,
            &MenuItem::with_id(app, "new-tab", "New tab", true, None::<&str>)?,
            &MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?,
        ],
    )?;
    TrayIconBuilder::with_id("main")
        // Made from branding/tray.svg by `npm run icons`: 32 px, which Windows scales down at 100 %.
        // Decoded when the app is built, so the app ships no image decoder.
        .icon(tauri::include_image!("../../../branding/out/tray-32.png"))
        .tooltip("Dialect")
        .menu(&menu)
        // Left-click shows the window; the menu is on the right button.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show(app),
            "new-tab" => {
                show(app);
                let _ = app.emit_to("main", NEW_TAB_EVENT, ());
            }
            // As the window's ✕: the page's close guard asks first while output is unsaved, so the window is
            // shown for it. Closing the only window quits the app.
            "quit" => {
                show(app);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.close();
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Err(error) = tray(app) {
                eprintln!("Dialect: no notification-area icon, running without it: {error}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Dialect");
}
