use app_core::AppConfig;

#[tauri::command]
pub(crate) async fn import_custom_background(
    path: String,
    original_name: String,
    name: String,
) -> Result<AppConfig, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app_core::import_custom_background_file(path.into(), original_name, name)
    })
    .await
    .map_err(|error| format!("background import task failed: {error}"))?
}

#[tauri::command]
pub(crate) fn add_custom_background_url(name: String, url: String) -> Result<AppConfig, String> {
    app_core::add_custom_background_url(name, url)
}

#[tauri::command]
pub(crate) fn remove_custom_background(id: String) -> Result<AppConfig, String> {
    app_core::remove_custom_background(&id)
}

#[tauri::command]
pub(crate) fn resolve_custom_background_path(id: String) -> Result<String, String> {
    app_core::resolve_custom_background_path(&id)
}

#[tauri::command]
pub(crate) fn load_custom_background_shader(id: String) -> Result<String, String> {
    app_core::load_custom_background_shader(&id)
}
