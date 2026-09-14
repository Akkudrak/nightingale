use app_core::ProfileStore;

#[tauri::command]
pub(crate) fn load_profiles() -> ProfileStore {
    ProfileStore::load()
}

#[tauri::command]
pub(crate) fn create_profile(name: String) {
    let mut profile_store = ProfileStore::load();

    profile_store.create_profile(name);
}

#[tauri::command]
pub(crate) fn switch_profile(name: String) {
    let mut profile_store = ProfileStore::load();

    profile_store.switch_profile(&name);
}

#[tauri::command]
pub(crate) fn delete_profile(name: String) {
    let mut profile_store = ProfileStore::load();

    profile_store.delete_profile(&name);
}

#[tauri::command]
pub(crate) fn add_score(song_hash: String, score: u32) {
    let mut profile_store = ProfileStore::load();

    profile_store.add_score(&song_hash, score);
}

#[tauri::command]
pub(crate) fn add_favorite(song_hash: String) {
    let mut profile_store = ProfileStore::load();

    let profile = match profile_store.active.clone() {
        Some(p) => p,
        None => return,
    };

    profile_store.add_favorite(&profile, &song_hash);
}

#[tauri::command]
pub(crate) fn remove_favorite(song_hash: String) {
    let mut profile_store = ProfileStore::load();

    let profile = match profile_store.active.clone() {
        Some(p) => p,
        None => return,
    };

    profile_store.remove_favorite(&profile, &song_hash);
}
