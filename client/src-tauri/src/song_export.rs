//! Tauri commands wrapping `app_core::song_export` so the React frontend
//! can trigger full-song export and import from the song-details sidebar.
//! Mirrors the shape of [catalog_export.rs](crate::catalog_export) but
//! carries the full analysis bundle (audio + cache + cover + metadata),
//! so an import on a fresh install skips the AI re-analysis pipeline.

use std::path::Path;

use app_core::song_export::{export_song_full_to_path, import_song_full_from_path, ImportResult};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportSongResponse {
    pub file_hash: String,
    pub title: String,
    pub artist: String,
    pub imported_path: String,
}

#[tauri::command]
pub(crate) fn export_song_full(file_hash: String, output_path: String) -> Result<u64, String> {
    export_song_full_to_path(&file_hash, Path::new(&output_path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn import_song_full(
    zip_path: String,
    target_library_dir: Option<String>,
) -> Result<ImportSongResponse, String> {
    let target = target_library_dir
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(Path::new);
    let ImportResult {
        song,
        imported_path,
    } = import_song_full_from_path(Path::new(&zip_path), target).map_err(|e| e.to_string())?;
    Ok(ImportSongResponse {
        file_hash: song.file_hash,
        title: song.title,
        artist: song.artist,
        imported_path: imported_path.to_string_lossy().into_owned(),
    })
}
