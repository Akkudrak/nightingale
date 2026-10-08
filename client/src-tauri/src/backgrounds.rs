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
