mod analyzer;
mod cache;
mod catalog_export;
mod config;
mod deep_link;
mod logging;
mod lyrics;
mod microphones;
mod playback;
mod playback_queue;
mod playback_session;
mod profile;
mod scanner;
mod song_export;
mod vendor;

use analyzer::{
    cancel_analysis, delete_song_cache, enqueue, realign, reanalyze_force_transcribe,
    reanalyze_full, reanalyze_transcript, refresh_metadata, shift_key, shift_tempo,
};
use app_core::{AppConfig, PlaybackQueue, PlaybackSessionStore, SongsStore};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use cache::{calculate_cache_stats, clear_all, clear_models_command, clear_videos_command};
use catalog_export::export_song_catalog_zip;
use config::{load_config, save_config};
use lyrics::{apply_timed_lyrics, load_lyrics, provide_lrc, save_lyrics, search_lrclib_lyrics};
use microphones::{list_microphones, set_monitor_gain, start_mic_capture, stop_mic_capture};
use playback::{
    ensure_mp3_stems, ensure_playable_source_video, fetch_pixabay_videos, get_audio_paths,
    load_transcript,
};
use playback_queue::{
    add_playback_queue_entry, clear_playback_queue, load_playback_queue,
    remove_playback_queue_entry,
};
use playback_session::{load_playback_session, save_playback_session};
use profile::{
    add_favorite, add_score, create_profile, delete_profile, load_profiles, remove_favorite,
    switch_profile,
};
use scanner::{
    clear_library_source, jellyfin_login, jellyfin_ping, load_analysis_queue,
    load_library_menu_items, load_songs, load_songs_by_hashes, load_songs_meta, navidrome_login,
    navidrome_ping, plex_begin_pin, plex_manual_login, plex_ping, plex_poll_pin,
    set_library_source, trigger_scan,
};
use song_export::{export_song_full, import_song_full};
use tauri::{Manager, RunEvent, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use vendor::{is_ready, trigger_setup};

#[tauri::command]
fn get_media_endpoint() -> app_core::MediaEndpoint {
    app_core::media_server::endpoint()
}

#[tauri::command]
fn frontend_ready(window: tauri::Window) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())
}

/// True for native fullscreen or macOS "simple" fullscreen (`set_simple_fullscreen`), where
/// `isFullscreen()` stays false but the window fills the screen.
#[tauri::command]
fn window_immersive(window: tauri::WebviewWindow) -> Result<bool, String> {
    if window.is_fullscreen().map_err(|e| e.to_string())? {
        return Ok(true);
    }
    #[cfg(target_os = "macos")]
    {
        let inner = window.inner_size().map_err(|e| e.to_string())?;
        if let Some(monitor) = window.current_monitor().map_err(|e| e.to_string())? {
            let ms = monitor.size();
            let dw = (inner.width as i32 - ms.width as i32).abs();
            let dh = (inner.height as i32 - ms.height as i32).abs();
            if dw <= 2 && dh <= 2 {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// macOS simple fullscreen clears `Miniaturizable`; exit that mode before minimizing.
#[tauri::command]
fn minimize_window(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = window.set_simple_fullscreen(false);
    }
    window.minimize().map_err(|e| e.to_string())
}

/// Switch from desktop mode to Server/Guest mode: spawn the sibling
/// `server.exe` (or `server` on macOS/Linux) with the same data folder
/// the desktop was using, then quit the Tauri process.
///
/// Invoked by Settings → Playback → "Server/Guest mode" after an
/// explicit confirmation dialog on the JS side. The reverse trip —
/// desktop from the web — is intentionally unsupported: only the
/// desktop shortcut can bring the GUI back. That's why the JS caller
/// never offers a "return to desktop" button in server mode.
///
/// Resolution order for the server binary path:
///   1. `current_exe().parent() / "server[.exe]"` — Tauri's bundler
///      drops `externalBin` siblings next to the main executable, so
///      this is the install-time location. The release workflow
///      (`.github/workflows/release.yml`) builds the server crate in
///      the same matrix and stages it at
///      `client/src-tauri/binaries/server-<target>[.exe]` so the
///      bundler picks it up.
///   2. A clear error string back to the JS side if the file is
///      missing — the dialog surfaces it via toast.error and the
///      desktop stays open.
///
/// Library handling: we only pass `--library <path>` when the current
/// `library_source` is the `Folder` variant. For Jellyfin / Navidrome
/// / Plex the server's `pin_folder_library` would unconditionally
/// overwrite the configured source with a folder, so passing
/// `--library` would silently flip the user's setup. See
/// `client/src-server/src/main.rs::pin_folder_library` for the
/// overwrite semantics.
///
/// Returns the URL the operator should visit. The JS caller displays
/// it in a toast before exiting so the operator always has a copy
/// even when the auto-open-browser call below fails.
#[tauri::command]
fn enter_server_guest_mode(app: tauri::AppHandle) -> Result<String, String> {
    let config = AppConfig::load();
    let data_path = config.effective_data_path();

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let bin_name = if cfg!(windows) { "server.exe" } else { "server" };
    let server = exe.with_file_name(bin_name);
    if !server.exists() {
        return Err(format!(
            "Server binary not found at {}. Reinstall Nightingale or copy {} next to Nightingale.exe.",
            server.display(),
            bin_name,
        ));
    }

    let mut cmd = std::process::Command::new(&server);
    cmd.arg("--bind").arg("0.0.0.0:8080").arg("--data").arg(&data_path);

    // Mirror the CREATE_NO_WINDOW pattern from
    // `app-core/src/vendor.rs::silent_command` so server.exe doesn't
    // pop a console window on Windows. `silent_command` itself is
    // `pub(crate)`; the duplication is small (one cfg-gated block).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    if let Some(app_core::LibrarySource::Folder { path }) = &config.library_source {
        cmd.arg("--library").arg(path);
    }

    cmd.spawn()
        .map_err(|e| format!("Failed to launch server: {}", e))?;

    // Give the server a moment to bind 0.0.0.0:8080 before the browser
    // tries to connect. 500ms is a guess — `cmd.spawn()` returns once
    // the child process is created, but the bind/listen loop in the
    // server crate is async and not instant. A small sleep is cheaper
    // than polling the port and good enough for a localhost open.
    std::thread::sleep(std::time::Duration::from_millis(500));

    let url = "http://localhost:8080/guest";

    // Auto-open the operator's browser to the guest landing page so the
    // switch is visible end-to-end — the server is serving and the URL
    // is reachable from a normal browser. Any error here is non-fatal:
    // the JS side shows the URL in a toast as a fallback, and the
    // JS-side `exitApp()` call still runs afterwards. We deliberately
    // do NOT call `app.exit(0)` here — doing so would race the WebView
    // teardown against the toast render, so the operator might never
    // see the URL.
    if let Err(error) = app.opener().open_url(url, None::<&str>) {
        eprintln!("[server-guest] failed to open browser: {error}");
    }

    Ok(url.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logging::init();

    tauri::Builder::default()
        .manage(PlaybackQueue::default())
        .manage(PlaybackSessionStore::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // The `deep-link` feature on `tauri_plugin_single_instance`
            // auto-forwards argv on Windows/Linux to the deep-link
            // plugin's `on_open_url` handler, so we don't have to do
            // any parsing here. On macOS this closure never fires
            // (the OS uses Apple Events). We still bring the window
            // forward defensively when a second instance is spawned
            // with a URL on argv before our deep-link subscription
            // lands.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            // Init
            frontend_ready,
            window_immersive,
            minimize_window,
            enter_server_guest_mode,
            // Config
            load_config,
            save_config,
            // Cache
            calculate_cache_stats,
            clear_videos_command,
            clear_models_command,
            clear_all,
            // Profile
            load_profiles,
            switch_profile,
            create_profile,
            delete_profile,
            add_score,
            add_favorite,
            remove_favorite,
            // Playback queue
            load_playback_queue,
            add_playback_queue_entry,
            remove_playback_queue_entry,
            clear_playback_queue,
            // Playback session
            load_playback_session,
            save_playback_session,
            // Scanner
            trigger_scan,
            set_library_source,
            clear_library_source,
            jellyfin_login,
            jellyfin_ping,
            navidrome_login,
            navidrome_ping,
            plex_begin_pin,
            plex_poll_pin,
            plex_manual_login,
            plex_ping,
            load_songs,
            load_songs_by_hashes,
            load_songs_meta,
            load_analysis_queue,
            load_library_menu_items,
            // Analyzer
            enqueue,
            cancel_analysis,
            delete_song_cache,
            reanalyze_transcript,
            reanalyze_full,
            realign,
            reanalyze_force_transcribe,
            refresh_metadata,
            shift_key,
            shift_tempo,
            // Lyrics
            load_lyrics,
            search_lrclib_lyrics,
            save_lyrics,
            provide_lrc,
            apply_timed_lyrics,
            // Playback
            load_transcript,
            get_audio_paths,
            ensure_mp3_stems,
            ensure_playable_source_video,
            fetch_pixabay_videos,
            get_media_endpoint,
            list_microphones,
            start_mic_capture,
            stop_mic_capture,
            // Vendor
            is_ready,
            trigger_setup,
            // Catalog export
            export_song_catalog_zip,
            // Full-song export/import (audio + cache + cover, no re-analysis)
            export_song_full,
            import_song_full
        ])
        .setup(|app| {
            let _ = dotenvy::dotenv();
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            app_core::startup()?;
            app_core::media_server::start()?;
            let media_endpoint = app_core::media_server::endpoint();

            let config = AppConfig::load();
            set_monitor_gain(config.mic_monitor_gain());
            app.handle()
                .asset_protocol_scope()
                .allow_directory(config.effective_data_path(), true)
                .map_err(|e| format!("failed to allow asset protocol for data path: {e}"))?;
            app.handle()
                .asset_protocol_scope()
                .allow_directory(app_core::default_nightingale_dir(), true)
                .map_err(|e| format!("failed to allow asset protocol for default path: {e}"))?;
            for root in app_core::cache_roots() {
                app.handle()
                    .asset_protocol_scope()
                    .allow_directory(root, true)
                    .map_err(|e| format!("failed to allow asset protocol for cache path: {e}"))?;
            }
            let json = serde_json::to_string(&config).map_err(|e| e.to_string())?;
            let b64 = B64.encode(json.as_bytes());

            let songs_meta = SongsStore::load_meta();
            let meta_json = serde_json::to_string(&songs_meta).map_err(|e| e.to_string())?;
            let meta_b64 = B64.encode(meta_json.as_bytes());

            let endpoint_json =
                serde_json::to_string(&media_endpoint).map_err(|e| e.to_string())?;
            let endpoint_b64 = B64.encode(endpoint_json.as_bytes());

            let init_script = format!(
                "window.__NIGHTINGALE_APP_CONFIG__ = JSON.parse(atob('{b64}')); \
                 window.__NIGHTINGALE_SONGS_META__ = JSON.parse(atob('{meta_b64}')); \
                 window.__NIGHTINGALE_MEDIA_ENDPOINT__ = JSON.parse(atob('{endpoint_b64}'));",
            );

            let window_config = app
                .config()
                .app
                .windows
                .first()
                .ok_or_else(|| "tauri.conf.json must define at least one window".to_string())?;

            let window = WebviewWindowBuilder::from_config(app.handle(), window_config)
                .map_err(|e| e.to_string())?
                .initialization_script(init_script)
                .build()
                .map_err(|e| e.to_string())?;

            if config.fullscreen == Some(true) {
                let _ = window.set_simple_fullscreen(true);
            }

            // Wire the `nightingale://catalog/v1/import?p=…` deep-link
            // handler. The plugin re-emits the URL through `on_open_url`
            // on warm starts; `get_current()` covers the cold-start case
            // where the OS spawns a fresh process with the URL on argv.
            deep_link::register(&app.handle());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let RunEvent::Exit = event {
                app_core::shutdown_server();
            }
        });
}
