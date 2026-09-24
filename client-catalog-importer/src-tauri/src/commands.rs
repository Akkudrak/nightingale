//! Tauri IPC commands exposed to the React UI.
//!
//! Four commands:
//!
//! - `read_importer_config` / `write_importer_config` — round-trip
//!   the importer's own `%APPDATA%/com.rzru.catalog-importer/config.json`.
//!   The deep link in `deep_link.rs` reads this same config on every
//!   import to know where to drop the MP3 and write the DB row.
//! - `list_analyzed_songs` — enumerate the user's analysed songs
//!   from `songs.db` so the modal can render checkboxes.
//! - `export_song_zips` — write one \`schema_version: 1\` bundle per
//!   selected song into a user-chosen folder. Each result lands as
//!   an \`export-song-done\` event; failures are isolated per-zip and
//!   never abort the batch.

use std::path::PathBuf;
use std::thread;

use app_core::{
    catalog_export::{build_catalog_zip, slug_root_folder},
    catalog_import::CatalogImportDone,
    default_config_path, list_analyzed_songs as app_list_analyzed_songs,
    load_importer_config, load_song_by_hash_for_export, save_importer_config, ImporterConfig,
    Song,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

const EXPORT_EVENT_NAME: &str = "export-song-done";

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

/// Subset of [`Song`] exposed to the React modal for the export
/// feature. We don't pass the full `Song` (with `payload`, transcript
/// source, USDX bundle, etc.) because the frontend only renders a
/// checkbox + title + artist + album.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SongSummary {
    file_hash: String,
    title: String,
    artist: String,
    album: String,
    duration_secs: f64,
    is_analyzed: bool,
}

impl From<Song> for SongSummary {
    fn from(song: Song) -> Self {
        Self {
            file_hash: song.file_hash,
            title: song.title,
            artist: song.artist,
            album: song.album,
            duration_secs: song.duration_secs,
            is_analyzed: song.is_analyzed,
        }
    }
}

/// Enumerate every analysed song in the user's `songs.db`. Used by the
/// export modal to populate its checkbox list. The DB is opened in
/// `MigrateMode::ProbeOnly` mode so we never run a schema migration
/// behind the user's back — same trust boundary the deep-link and
/// drop paths observe.
///
/// Returns an empty Vec when no config exists yet (the wizard is
/// still showing) or when the library has no analysed songs — the
/// React side uses the empty result to hide the **Export your
/// songs…** button entirely.
#[tauri::command]
pub(crate) fn list_analyzed_songs() -> Result<Vec<SongSummary>, String> {
    let cfg = load_importer_config(&default_config_path())
        .map_err(|e| format!("importer not configured: {e}"))?;
    app_list_analyzed_songs(&cfg.system_folder)
        .map(|songs| songs.into_iter().map(SongSummary::from).collect())
        .map_err(|e| e.to_string())
}

/// Export one or more analysed songs as catalog-format ZIPs. Each
/// zip lands at `<dest_dir>/<slug-titulo>-<artista>.zip` and is
/// byte-identical to what `app_core::catalog_export::build_catalog_zip`
/// would produce for the same song in the main Nightingale app.
///
/// Returns `Ok(())` immediately after spawning the worker thread;
/// per-zip results stream back as `export-song-done` events with
/// `CatalogImportDone` payloads — the same shape the existing
/// **Recent imports** list already knows how to render. A failure
/// in one zip is reported as a red row but does NOT abort the batch.
///
/// Returns `Err` only for precondition violations that make the
/// batch impossible to start: empty `file_hashes`, `dest_dir` that
/// is not a directory, or missing config.
#[tauri::command]
pub(crate) fn export_song_zips(
    app: AppHandle,
    file_hashes: Vec<String>,
    dest_dir: PathBuf,
) -> Result<(), String> {
    if file_hashes.is_empty() {
        return Err("no songs selected".into());
    }
    if !dest_dir.is_dir() {
        return Err(format!(
            "destination is not a directory: {}",
            dest_dir.display()
        ));
    }

    let cfg = load_importer_config(&default_config_path())
        .map_err(|e| format!("importer not configured: {e}"))?;

    thread::spawn(move || {
        for file_hash in file_hashes {
            let outcome = export_one(&cfg.system_folder, &dest_dir, &file_hash);
            let _ = app.emit(EXPORT_EVENT_NAME, outcome);
        }
    });

    Ok(())
}

/// Worker for a single zip. Kept private to the command so the
/// orchestration above reads as a flat loop.
fn export_one(system_folder: &PathBuf, dest_dir: &PathBuf, file_hash: &str) -> CatalogImportDone {
    let song = match load_song_by_hash_for_export(system_folder, file_hash) {
        Ok(Some(s)) => s,
        Ok(None) => {
            return CatalogImportDone::err(format!(
                "song not found (file_hash={file_hash})"
            ));
        }
        Err(e) => return CatalogImportDone::err(e.to_string()),
    };

    let bytes = match build_catalog_zip(&song) {
        Ok(b) => b,
        Err(e) => return CatalogImportDone::err(e.to_string()),
    };

    let dest_name = format!("{}.zip", slug_root_folder(&song.title, &song.artist));
    let dest_path = dest_dir.join(&dest_name);
    if let Err(e) = std::fs::write(&dest_path, &bytes) {
        return CatalogImportDone::err(format!(
            "write {}: {e}",
            dest_path.display()
        ));
    }

    CatalogImportDone::ok(
        song.file_hash,
        song.title,
        song.artist,
        dest_path.to_string_lossy().into_owned(),
    )
}
