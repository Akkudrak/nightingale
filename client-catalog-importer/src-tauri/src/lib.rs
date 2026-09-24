//! Tauri shell for the Nightingale Catalog Importer.
//!
//! Wires:
//! - `tauri-plugin-dialog` — folder pickers invoked from the React UI
//! - `tauri-plugin-deep-link` — listens for `nightingale-import://` URLs
//! - `tauri-plugin-single-instance` (with the `deep-link` feature) —
//!   re-forwards a second argv to the running instance instead of
//!   spawning a duplicate process on Windows
//!
//! The only IPC command set is the two importer config load/save
//! commands (`commands.rs`); everything else happens either via the
//! React UI rendering or via the deep-link event loop in
//! `deep_link.rs`.

mod commands;
mod deep_link;
mod drag_drop;
mod logging;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logging::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Re-fire a deep-link import when the user double-clicks
            // the `nightingale-import://` URL while we're already
            // running. Just bring the window to the foreground; the
            // argv-forwarding done by the `deep-link` feature will
            // re-trigger `deep_link::register`'s `on_open_url` handler.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            commands::read_importer_config,
            commands::write_importer_config,
            commands::list_analyzed_songs,
            commands::export_song_zips,
        ])
        .setup(|app| {
            deep_link::register(app.handle());
            drag_drop::register(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Nightingale Catalog Importer");
}
