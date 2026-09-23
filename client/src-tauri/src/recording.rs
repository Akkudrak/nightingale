use app_core::{AddRecordingInput, RecordingRecord, RecordingStore};

#[tauri::command]
pub(crate) fn load_recordings() -> Vec<RecordingRecord> {
    // The store sorts newest-first on save, so the call order here is
    // already what the history dialog wants. We re-sort defensively in
    // case a future migration imports a pre-sorted index.
    let mut store = RecordingStore::load();
    store.recordings.sort_by(|a, b| b.recorded_at.cmp(&a.recorded_at));
    store.recordings
}

#[tauri::command]
pub(crate) fn save_recording(input: AddRecordingInput) -> Result<String, String> {
    let mut store = RecordingStore::load();
    store.add(input)
}

#[tauri::command]
pub(crate) fn delete_recording(id: String) {
    let mut store = RecordingStore::load();
    store.delete(&id);
}

/// Resolves a recording's WAV to an absolute filesystem path so the
/// webview can play it through the asset protocol. `None` when the id
/// is unknown (e.g. a stale row from a different install). The
/// `RecordingStore::wav_path_for` helper already canonicalises inside
/// the data folder, so the asset-protocol scope configured in
/// `lib.rs::run` (which allows the data dir) is the only check required.
#[tauri::command]
pub(crate) fn get_recording_path(id: String) -> Option<String> {
    RecordingStore::wav_path_for(&id).map(|path| path.to_string_lossy().into_owned())
}