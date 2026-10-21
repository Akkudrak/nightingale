#[tauri::command]
pub(crate) fn export_song_nge(file_hash: String, dest_dir: String) -> Result<String, String> {
    app_core::export_song_nge(&file_hash, std::path::Path::new(&dest_dir))
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}
