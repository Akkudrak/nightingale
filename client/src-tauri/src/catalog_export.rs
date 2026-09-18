//! Tauri commands wrapping the `app_core::catalog_export` module so
//! the React frontend can trigger an export from a song-details sidebar
//! action. The frontend already prompts for the output path via
//! `@tauri-apps/plugin-dialog`'s `save()`; we receive the chosen path
//! here and write the ZIP bytes into it.

use std::path::PathBuf;

use app_core::catalog_export::export_song_to_path;

#[tauri::command]
pub(crate) fn export_song_catalog_zip(
    file_hash: String,
    output_path: String,
) -> Result<u64, String> {
    let path = PathBuf::from(&output_path);
    export_song_to_path(&file_hash, &path).map_err(|e| e.to_string())
}
