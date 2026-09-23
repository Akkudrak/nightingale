//! Tauri IPC commands exposed to the React UI.
//!
//! Two commands, one for read and one for write of the importer's
//! own `%APPDATA%/com.rzru.catalog-importer/config.json`. The deep
//! link in `deep_link.rs` reads this same config on every import to
//! know where to drop the MP3 and write the DB row.

use app_core::{
    default_config_path, load_importer_config, save_importer_config, ImporterConfig,
};
use std::path::PathBuf;

/// Tauri command. Returns the parsed `ImporterConfig` if a config
/// file exists at the user's AppData location. Empty `Option` means
/// "no config yet" — the React UI takes that as the trigger to show
/// the first-run wizard.
#[tauri::command]
pub(crate) fn read_importer_config() -> Option<ImporterConfig> {
    load_importer_config(&default_config_path()).ok()
}

/// Tauri command. Writes the supplied config back to
/// `%APPDATA%/com.rzru.catalog-importer/config.json`. Both folders
/// must be absolute, distinct, and resolvable; the React UI enforces
/// this before invoking us but we double-check server-side too as a
/// defence-in-depth measure before the next deep-link import lands.
#[tauri::command]
pub(crate) fn write_importer_config(config: ImporterConfig) -> Result<(), String> {
    validate(&config)?;
    let path = default_config_path();
    save_importer_config(&path, &config).map_err(|e| e.to_string())
}

fn validate(cfg: &ImporterConfig) -> Result<(), String> {
    if !cfg.system_folder.is_absolute() {
        return Err(format!(
            "system_folder must be absolute: {}",
            cfg.system_folder.display()
        ));
    }
    if !cfg.library_folder.is_absolute() {
        return Err(format!(
            "library_folder must be absolute: {}",
            cfg.library_folder.display()
        ));
    }
    if paths_equal(&cfg.system_folder, &cfg.library_folder) {
        return Err("system_folder and library_folder must differ".into());
    }
    Ok(())
}

/// Canonicalised equality check that strips Windows verbatim prefix
/// (`\\?\`) so `C:\Users\u\.nightingale` matches `\\?\C:\Users\u\.nightingale`.
fn paths_equal(a: &PathBuf, b: &PathBuf) -> bool {
    let strip = |s: String| {
        s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
    };
    let ca = std::fs::canonicalize(a)
        .ok()
        .map(|p| strip(p.to_string_lossy().into_owned()));
    let cb = std::fs::canonicalize(b)
        .ok()
        .map(|p| strip(p.to_string_lossy().into_owned()));
    match (ca, cb) {
        (Some(x), Some(y)) => x.eq_ignore_ascii_case(&y),
        _ => false,
    }
}
