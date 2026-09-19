use app_core::{ensure_mp3_stems_ready_payload, AudioPaths, PixabayVideoDownloaded};
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub(crate) fn load_transcript(file_hash: String) -> Result<serde_json::Value, String> {
    app_core::load_transcript(&file_hash).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn get_audio_paths(file_hash: String) -> AudioPaths {
    app_core::get_audio_paths(&file_hash)
}

#[tauri::command]
pub(crate) fn ensure_mp3_stems(app: AppHandle, file_hash: String) {
    std::thread::spawn(move || {
        let _ = app.emit("stems-ready", ensure_mp3_stems_ready_payload(file_hash));
    });
}

#[tauri::command]
pub(crate) fn ensure_playable_source_video(file_hash: String) -> Option<String> {
    app_core::ensure_playable_source_video(&file_hash)
        .ok()
        .flatten()
}

#[tauri::command]
pub(crate) fn fetch_pixabay_videos(app: AppHandle, flavor: String) -> Vec<String> {
    let cached = app_core::get_cached_pixabay_videos(&flavor);

    if flavor == "custom" {
        // User-supplied folder under `<cache>/videos/custom/`. We never
        // auto-download into it — the user drops files themselves — and
        // skipping the spawn also avoids burning Pixabay quota for a
        // folder Nightingale doesn't own.
        return cached;
    }

    let flavor_clone = flavor.clone();
    std::thread::spawn(move || {
        app_core::download_pixabay_videos(&flavor_clone, move |path, evicted_path| {
            let _ = app.emit(
                "pixabay-video-downloaded",
                PixabayVideoDownloaded::new(flavor.clone(), path, evicted_path),
            );
        });
    });

    cached
}

/// Search YouTube Data API v3 with the user's pasted key. The
/// `<query> karaoke` suffix and `maxResults=5` cap live here so the
/// frontend never has to know about them. Returned `Vec<YouTubeHit>`
/// serialises through tauri::ip::ResponseType automatically — see
/// `app-core::youtube::YouTubeHit`.
///
/// Errors are bubbled as a string the frontend shows verbatim via
/// `toast.error(...)`. The common "no key configured" case is the
/// same message we surface when the user toggles the search-bar
/// checkbox without first opening Settings → Library.
#[tauri::command]
pub(crate) fn search_youtube_videos(query: String) -> Result<Vec<app_core::YouTubeHit>, String> {
    let config = app_core::AppConfig::load();
    let api_key = config.youtube_api_key().ok_or_else(|| {
        "YouTube API key is not configured. Add it in Settings → Library.".to_string()
    })?;
    let trimmed = query.trim();
    let with_suffix = format!("{trimmed} karaoke");
    app_core::search_youtube(api_key, &with_suffix, 5)
}
