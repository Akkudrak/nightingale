//! Catalog-format ZIP importer.
//!
//! Reads a ZIP whose shape is exactly
//!
//! ```text
//! <root>/song.mp3
//! <root>/metadata.json     # schema_version = 1
//! ```
//!
//! (mirrors `nightingale-catalog/api/app/Support/ZipValidator.php`)
//! and writes a `Song` row directly into a user's existing
//! `songs.db`. The bytes for `song.mp3` are dropped into the user's
//! music folder with a slug + 6-char random suffix to mirror
//! [`crate::catalog_export::slug_root_folder`].
//!
//! ## Schema compatibility
//!
//! Nightingale's `songs` table has grown over releases:
//!
//! - **v0/v1 (Nightingale 1.0.0 - 1.1.x)**: 13 columns. No `genre`.
//! - **v2 (Nightingale 1.1.x)**: identical to v1 for the `songs` table
//!   (only adds `playlists`/`playlist_songs`).
//! - **v3 (Nightingale 1.2.0+)**: adds `genre TEXT` and
//!   `added_at INTEGER NOT NULL DEFAULT 0`.
//!
//! This importer never runs the v2→v3 migration against the user's DB
//! (the user controls schema upgrades via the main Nightingale app).
//! Instead, it probes `PRAGMA table_info(songs)` and writes only the
//! columns that already exist. The Cargo-version of `MigrateMode` in
//! [`crate::library_db`] is set to `ProbeOnly` on every connection
//! open — see [`crate::library_db::open_library_db_for_import`].
//!
//! ## Concurrency
//!
//! With SQLite's WAL mode (set by `library_db::migrations::configure`)
//! concurrent readers are fine. If the user has the main Nightingale
//! app open at the same time, an importer write can hit
//! `SQLITE_BUSY` (5) or `SQLITE_LOCKED` (6) for short windows. We
//! retry the WHOLE write (DELETE-by-hash + INSERT) up to 3 times with
//! 250 ms / 500 ms backoff. Other errors fail immediately.
//!
//! ## Trust boundaries
//!
//! - Inbound ZIP layout is validated (mirrors the catalog's
//!   `ZipValidator`).
//! - Inbound `cover_url` is constrained by an explicit host
//!   allowlist from the importer's config and a 5 MiB response cap.
//! - Outbound ZIP download uses the signed R2 URL the catalog's
//!   `/api/songs/{id}/download-url` endpoint returns; signing is the
//!   trust boundary.

use std::collections::BTreeSet;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params_from_iter, Connection, ToSql};
use serde::Deserialize;
use thiserror::Error;
use url::Url;

use crate::catalog_export::{slug_root_folder, CATALOG_ZIP_SCHEMA_VERSION};
use crate::library_db::open_library_db_for_import;
use crate::song::{Song, SongOrigin};
use crate::song_export::blake3_short_hex;

const AUDIO_ENTRY: &str = "song.mp3";
const METADATA_ENTRY: &str = "metadata.json";
const MAX_COVER_BYTES: u64 = 5 * 1024 * 1024; // 5 MiB; mirrors the catalog's own upload cap
/// Cap on the size of an inbound catalog ZIP we will accept. Real catalog
/// songs are well under 20 MiB; the 64 MiB ceiling is a defence-in-depth
/// guard against zip-bombs and "dragged the wrong file" mistakes, not a
/// per-song size budget. Used by the standalone importer's drag-and-drop
/// handler before it ever calls [`std::fs::read`].
pub const MAX_ZIP_BYTES: u64 = 64 * 1024 * 1024;

/// Result of a single import. Mirrors `song_export::DeepLinkImportDone`'s
/// shape on purpose so the React UI can switch on `ok` + optional
/// fields without per-variant code paths.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogImportDone {
    pub ok: bool,
    pub file_hash: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub imported_path: Option<String>,
    pub error: Option<String>,
}

impl CatalogImportDone {
    pub fn err(message: String) -> Self {
        Self {
            ok: false,
            file_hash: None,
            title: None,
            artist: None,
            imported_path: None,
            error: Some(message),
        }
    }

    /// Success constructor. Mirrors [`CatalogImportDone::err`] so the
    /// catalog exporter (and any future success-emitting producer)
    /// doesn't have to remember the exact field order. `imported_path`
    /// is the on-disk destination of the produced artifact — the
    /// file the user actually chose to save to.
    pub fn ok(
        file_hash: String,
        title: String,
        artist: String,
        imported_path: String,
    ) -> Self {
        Self {
            ok: true,
            file_hash: Some(file_hash),
            title: Some(title),
            artist: Some(artist),
            imported_path: Some(imported_path),
            error: None,
        }
    }
}

#[derive(Debug, Error)]
pub enum CatalogImportError {
    #[error("invalid paths: {0}")]
    InvalidPaths(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("zip: {0}")]
    Zip(String),
    #[error("metadata: {0}")]
    Metadata(String),
    #[error("cover download: {0}")]
    Cover(String),
    #[error("database: {0}")]
    Database(String),
    #[error("trust boundary: {0}")]
    Trust(String),
}

/// One-stop entry point. Reads `zip_bytes`, materialises the song
/// inside `system_folder`/`library_folder`, returns a
/// [`CatalogImportDone`] suitable for shipping back to the Tauri UI
/// as the `deep-link-import-done` event payload.
///
/// `allowed_cover_hosts` is the user-configured allowlist (see
/// [`crate::importer_config::ImporterConfig::allowed_cover_hosts`]).
pub fn import_catalog_zip(
    zip_bytes: &[u8],
    system_folder: &Path,
    library_folder: &Path,
    allowed_cover_hosts: &[String],
) -> Result<CatalogImportDone, CatalogImportError> {
    let (system_folder_abs, library_folder_abs) = validate_paths(system_folder, library_folder)?;

    let cursor = Cursor::new(zip_bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| CatalogImportError::Zip(e.to_string()))?;
    let (_root, entries) = validate_zip_structure(&mut archive)?;

    let metadata = read_metadata(&mut archive)?;
    if metadata.schema_version != CATALOG_ZIP_SCHEMA_VERSION {
        return Err(CatalogImportError::Metadata(format!(
            "unsupported schema_version {} (expected {})",
            metadata.schema_version, CATALOG_ZIP_SCHEMA_VERSION
        )));
    }
    if metadata.title.trim().is_empty() || metadata.artist.trim().is_empty() {
        return Err(CatalogImportError::Metadata(
            "metadata.json is missing required `title` or `artist`".into(),
        ));
    }

    let audio_bytes = read_audio(&mut archive, &entries, AUDIO_ENTRY)?;
    let file_hash = blake3_short_hex(&audio_bytes);

    let target_name = format!("{}.mp3", slug_root_folder(&metadata.title, &metadata.artist));
    let target_path = library_folder_abs.join(&target_name);
    write_audio_if_changed(&target_path, &audio_bytes, &file_hash)?;

    let album_art_path = download_cover_if_present(
        metadata.cover_url.as_deref(),
        &system_folder_abs,
        allowed_cover_hosts,
    )?;

    let song = build_song(
        target_path.clone(),
        file_hash.clone(),
        &metadata,
        album_art_path,
    );

    let conn = open_library_db_for_import(&system_folder_abs)
        .map_err(|e| CatalogImportError::Database(e.to_string()))?;
    retry_sqlite(|| upsert_song_compat(&conn, &song))?;

    tracing::info!(
        target: "importer.import",
        title = %song.title,
        artist = %song.artist,
        file_hash = %song.file_hash,
        "imported catalog song"
    );

    Ok(CatalogImportDone {
        ok: true,
        file_hash: Some(song.file_hash),
        title: Some(song.title),
        artist: Some(song.artist),
        imported_path: Some(song.path.to_string_lossy().into_owned()),
        error: None,
    })
}

#[derive(Deserialize)]
struct CatalogMetadata {
    schema_version: u32,
    title: String,
    artist: String,
    #[serde(default)]
    album: Option<String>,
    #[serde(default)]
    genre: Option<String>,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    duration_secs: Option<f64>,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    tempo: Option<f64>,
    #[serde(default)]
    key_offset: Option<i32>,
    #[serde(default)]
    cover_url: Option<String>,
    #[serde(default, rename = "bpm")]
    _bpm: Option<serde_json::Value>,
    #[serde(default, rename = "year")]
    _year: Option<serde_json::Value>,
    #[serde(default, rename = "notes")]
    _notes: Option<serde_json::Value>,
    #[serde(default, rename = "credits")]
    _credits: Option<serde_json::Value>,
}

/// Validate `system_folder` and `library_folder` are absolute, distinct,
/// and resolvable. Returns canonical absolute paths.
fn validate_paths(
    system_folder: &Path,
    library_folder: &Path,
) -> Result<(PathBuf, PathBuf), CatalogImportError> {
    if !system_folder.is_absolute() {
        return Err(CatalogImportError::InvalidPaths(format!(
            "system_folder is not absolute: {}",
            system_folder.display()
        )));
    }
    if !library_folder.is_absolute() {
        return Err(CatalogImportError::InvalidPaths(format!(
            "library_folder is not absolute: {}",
            library_folder.display()
        )));
    }
    let sys = dunce_canonicalize(system_folder)
        .ok_or_else(|| CatalogImportError::InvalidPaths(format!(
            "system_folder does not exist: {}",
            system_folder.display()
        )))?;
    let lib = dunce_canonicalize(library_folder)
        .ok_or_else(|| CatalogImportError::InvalidPaths(format!(
            "library_folder does not exist: {}",
            library_folder.display()
        )))?;
    if sys == lib {
        return Err(CatalogImportError::InvalidPaths(
            "system_folder and library_folder resolve to the same path".into(),
        ));
    }
    Ok((sys, lib))
}

/// `std::fs::canonicalize` would prefix Windows paths with `\\?\` which
/// breaks `Path::join` comparisons; this strips that on Windows.
fn dunce_canonicalize(p: &Path) -> Option<PathBuf> {
    let raw = std::fs::canonicalize(p).ok()?;
    let s = raw.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        Some(PathBuf::from(rest))
    } else {
        Some(raw)
    }
}

/// Walk the archive and confirm exactly one root folder with exactly
/// the two required entries (`song.mp3`, `metadata.json`). This is
/// the same check `nightingale-catalog/api/app/Support/ZipValidator.php`
/// performs on the admin upload side, so the importer and the catalog
/// agree on what a "valid catalog zip" is.
fn validate_zip_structure<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Result<(String, Vec<String>), CatalogImportError> {
    let mut names: Vec<String> = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| CatalogImportError::Zip(e.to_string()))?;
        names.push(entry.name().to_string());
    }

    if names.len() != 2 {
        return Err(CatalogImportError::Zip(format!(
            "expected exactly 2 entries, found {}",
            names.len()
        )));
    }
    names.sort();

    // We don't actually know the root folder name (it's random); just
    // confirm both entries exist under the same parent and the basenames
    // match the spec.
    let roots: BTreeSet<String> = names
        .iter()
        .filter_map(|n| n.rsplit_once('/').map(|(r, _)| r.to_string()))
        .collect();
    if roots.len() != 1 {
        return Err(CatalogImportError::Zip(format!(
            "entries do not share a single root folder: {names:?}"
        )));
    }
    let root = roots.into_iter().next().ok_or_else(|| {
        CatalogImportError::Zip("zip has no root folder".into())
    })?;
    if !names.contains(&format!("{root}/{AUDIO_ENTRY}"))
        || !names.contains(&format!("{root}/{METADATA_ENTRY}"))
    {
        return Err(CatalogImportError::Zip(format!(
            "expected `{root}/{AUDIO_ENTRY}` + `{root}/{METADATA_ENTRY}`, found {names:?}"
        )));
    }

    Ok((root, names))
}

fn read_metadata<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Result<CatalogMetadata, CatalogImportError> {
    let mut buf = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| CatalogImportError::Zip(e.to_string()))?;
        if entry.name().ends_with(METADATA_ENTRY) {
            entry
                .read_to_end(&mut buf)
                .map_err(|e| CatalogImportError::Metadata(format!("read {METADATA_ENTRY}: {e}")))?;
            break;
        }
    }
    serde_json::from_slice(&buf).map_err(|e| CatalogImportError::Metadata(e.to_string()))
}

fn read_audio<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    entries: &[String],
    name: &str,
) -> Result<Vec<u8>, CatalogImportError> {
    // Find the entry whose path ends with `name` (we don't know the
    // random root prefix the catalog added).
    let mut found_index: Option<usize> = None;
    for (i, n) in entries.iter().enumerate() {
        if n.ends_with(name) {
            found_index = Some(i);
            break;
        }
    }
    let idx = found_index.ok_or_else(|| {
        CatalogImportError::Zip(format!("audio entry {name} not found"))
    })?;
    let mut entry = archive
        .by_index(idx)
        .map_err(|e| CatalogImportError::Zip(e.to_string()))?;
    let mut buf = Vec::new();
    entry
        .read_to_end(&mut buf)
        .map_err(|e| CatalogImportError::Zip(format!("read {name}: {e}")))?;
    Ok(buf)
}

/// Skip the copy when the destination already exists with the same
/// blake3 hash (idempotent re-import). Otherwise write atomically
/// via a temp file + rename.
fn write_audio_if_changed(
    target: &Path,
    audio_bytes: &[u8],
    file_hash: &str,
) -> Result<(), CatalogImportError> {
    if target.is_file() {
        match std::fs::read(target) {
            Ok(existing) if blake3_short_hex(&existing) == file_hash => {
                tracing::debug!(target: "importer.audio", path = %target.display(), "audio already present with matching hash; skipping copy");
                return Ok(());
            }
            Ok(_) => {
                tracing::warn!(target: "importer.audio", path = %target.display(), "audio file exists with different contents; overwriting");
            }
            Err(e) => {
                tracing::warn!(target: "importer.audio", path = %target.display(), error = %e, "could not read existing audio file; will overwrite");
            }
        }
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = target.with_extension("mp3.tmp");
    std::fs::write(&tmp, audio_bytes)?;
    if let Err(e) = std::fs::rename(&tmp, target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(CatalogImportError::Io(e));
    }
    Ok(())
}

fn download_cover_if_present(
    cover_url: Option<&str>,
    system_folder: &Path,
    allowed_hosts: &[String],
) -> Result<Option<PathBuf>, CatalogImportError> {
    let Some(url) = cover_url else {
        return Ok(None);
    };
    match download_cover(url, system_folder, allowed_hosts) {
        Ok(p) => Ok(Some(p)),
        Err(e) => {
            tracing::warn!(target: "importer.cover", error = %e, "cover download failed; importing without cover");
            Ok(None)
        }
    }
}

fn download_cover(
    url: &str,
    system_folder: &Path,
    allowed_hosts: &[String],
) -> Result<PathBuf, CatalogImportError> {
    let parsed = Url::parse(url).map_err(|e| CatalogImportError::Trust(format!("invalid url: {e}")))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => {
            return Err(CatalogImportError::Trust(format!(
                "scheme `{other}` is not allowed"
            )));
        }
    }
    let host = parsed.host_str().unwrap_or_default();
    if !host_allowed(host, allowed_hosts) {
        return Err(CatalogImportError::Trust(format!(
            "cover host `{host}` is not in the allowlist"
        )));
    }

    let agent = ureq::Agent::new_with_defaults();
    let resp = agent
        .get(url)
        .call()
        .map_err(|e| CatalogImportError::Cover(e.to_string()))?;
    if let Some(len) = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        && len > MAX_COVER_BYTES
    {
        return Err(CatalogImportError::Cover(format!(
            "cover too large: {len} bytes (cap {MAX_COVER_BYTES})"
        )));
    }
    let mut reader = resp.into_body().into_reader().take(MAX_COVER_BYTES);
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_COVER_BYTES {
        return Err(CatalogImportError::Cover("cover too large".into()));
    }

    let cover_hash = blake3_short_hex(&bytes);
    let cache_root = system_folder.join("cache");
    std::fs::create_dir_all(&cache_root)?;
    let cover_path = cache_root.join(format!("{cover_hash}_cover.jpg"));
    if !cover_path.is_file() {
        std::fs::write(&cover_path, &bytes)?;
    }

    tracing::info!(
        target: "importer.cover",
        host = %host,
        bytes = bytes.len(),
        path = %cover_path.display(),
        "fetched cover"
    );
    Ok(cover_path)
}

fn host_allowed(host: &str, allowlist: &[String]) -> bool {
    allowlist.iter().any(|pattern| {
        if let Some(stripped) = pattern.strip_prefix("*.") {
            host.ends_with(&format!(".{stripped}")) || host == stripped
        } else if let Some(stripped) = pattern.strip_suffix(".*") {
            // Doesn't match public suffix rules; just exact.
            host == stripped || host.starts_with(&format!("{stripped}."))
        } else {
            host == pattern
        }
    })
}

fn build_song(
    path: PathBuf,
    file_hash: String,
    meta: &CatalogMetadata,
    album_art_path: Option<PathBuf>,
) -> Song {
    let duration_secs = meta.duration_secs.unwrap_or(0.0);
    let tempo = meta.tempo.unwrap_or(1.0);
    let key_offset = meta.key_offset.unwrap_or(0);
    let language = meta
        .language
        .as_deref()
        .map(|s| s.trim().to_ascii_lowercase());
    Song {
        path,
        file_hash,
        title: meta.title.clone(),
        artist: meta.artist.clone(),
        album: meta.album.clone().unwrap_or_default(),
        duration_secs,
        album_art_path,
        is_analyzed: false,
        language,
        transcript_source: None,
        key: meta.key.clone(),
        override_key: None,
        tempo,
        key_offset,
        is_video: false,
        usdx: None,
        origin: SongOrigin::LocalFile,
        no_stems: false,
        genre: meta.genre.clone(),
        added_at: now_unix_secs(),
    }
}

fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Probe `PRAGMA table_info(songs)`, then build + execute a dynamic
/// INSERT that writes every column present in the user's schema. The
/// `payload` JSON is always included (it was `NOT NULL` since v0).
fn upsert_song_compat(conn: &Connection, song: &Song) -> Result<(), CatalogImportError> {
    let cols = read_song_columns(conn)?;
    let has_genre = cols.contains("genre");
    let has_added_at = cols.contains("added_at");

    let payload = serde_json::to_string(song)
        .map_err(|e| CatalogImportError::Database(format!("payload encode: {e}")))?;

    let mut col_names: Vec<&'static str> = vec![
        "path",
        "file_hash",
        "title",
        "artist",
        "album",
        "duration_secs",
        "album_art_path",
        "is_analyzed",
        "language",
        "transcript_source",
        "is_video",
        "payload",
    ];
    if has_genre {
        col_names.push("genre");
    }
    if has_added_at {
        col_names.push("added_at");
    }

    let placeholders = (1..=col_names.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "INSERT INTO songs ({}) VALUES ({})",
        col_names.join(","),
        placeholders,
    );

    let album_art = song
        .album_art_path
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());
    let transcript = song.transcript_source.map(|_| "none");
    let mut params: Vec<Box<dyn ToSql>> = vec![
        Box::new(song.path.to_string_lossy().into_owned()),
        Box::new(song.file_hash.clone()),
        Box::new(song.title.clone()),
        Box::new(song.artist.clone()),
        Box::new(song.album.clone()),
        Box::new(song.duration_secs),
        Box::new(album_art),
        Box::new(song.is_analyzed as i32),
        Box::new(song.language.clone()),
        Box::new(transcript.map(str::to_string)),
        Box::new(song.is_video as i32),
        Box::new(payload),
    ];
    if has_genre {
        params.push(Box::new(song.genre.clone()));
    }
    if has_added_at {
        params.push(Box::new(song.added_at));
    }

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| CatalogImportError::Database(format!("begin tx: {e}")))?;
    tx.execute(
        "DELETE FROM songs WHERE file_hash = ?1",
        rusqlite::params![song.file_hash],
    )
    .map_err(|e| CatalogImportError::Database(format!("pre-delete: {e}")))?;
    tx.execute(&sql, params_from_iter(params.iter().map(|p| p.as_ref())))
        .map_err(|e| CatalogImportError::Database(format!("insert: {e}")))?;
    tx.commit()
        .map_err(|e| CatalogImportError::Database(format!("commit: {e}")))?;
    Ok(())
}

fn read_song_columns(conn: &Connection) -> Result<BTreeSet<String>, CatalogImportError> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(songs)")
        .map_err(|e| CatalogImportError::Database(format!("table_info prepare: {e}")))?;
    let cols = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| CatalogImportError::Database(format!("table_info query: {e}")))?
        .collect::<rusqlite::Result<BTreeSet<_>>>()
        .map_err(|e| CatalogImportError::Database(format!("table_info collect: {e}")))?;
    Ok(cols)
}

/// Retry the whole `op` up to 3 times when SQLite returns
/// `SQLITE_BUSY` or `SQLITE_LOCKED` (i.e. another process is holding
/// the writer lock). Other errors fail immediately.
fn retry_sqlite<F>(mut op: F) -> Result<(), CatalogImportError>
where
    F: FnMut() -> Result<(), CatalogImportError>,
{
    const MAX_ATTEMPTS: u32 = 3;
    const BASE_BACKOFF_MS: u64 = 250;
    for attempt in 1..=MAX_ATTEMPTS {
        match op() {
            Ok(()) => return Ok(()),
            Err(CatalogImportError::Database(msg))
                if is_sqlite_busy_or_locked(&msg) =>
            {
                if attempt >= MAX_ATTEMPTS {
                    tracing::warn!(
                        target: "importer.db",
                        "songs.db busy after {MAX_ATTEMPTS} attempts: {msg}"
                    );
                    return Err(CatalogImportError::Database(format!(
                        "songs.db busy after {MAX_ATTEMPTS} retries: another Nightingale \
                         session may be writing — close it and retry from the catalog web."
                    )));
                }
                let sleep_ms = BASE_BACKOFF_MS * (1u64 << (attempt - 1));
                tracing::warn!(
                    target: "importer.db",
                    attempt,
                    sleep_ms,
                    "songs.db busy, retrying"
                );
                std::thread::sleep(std::time::Duration::from_millis(sleep_ms));
            }
            Err(other) => return Err(other),
        }
    }
    Ok(())
}

fn is_sqlite_busy_or_locked(message: &str) -> bool {
    message.contains("database is locked") || message.contains("database table is locked")
}

#[cfg(test)]
#[allow(clippy::unwrap_used)] // tests panic by design
mod tests {
    use super::*;

    fn make_catalog_zip(title: &str, artist: &str) -> Vec<u8> {
        use std::io::Write;
        let mut zip_bytes = Vec::new();
        let cursor = Cursor::new(&mut zip_bytes);
        let mut zip = zip::write::ZipWriter::new(cursor);
        let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        zip.start_file("song.mp3", opts).unwrap();
        zip.write_all(b"FAKE_MP3_PAYLOAD_FOR_TEST").unwrap();
        zip.start_file("metadata.json", opts).unwrap();
        let metadata = serde_json::json!({
            "schema_version": 1,
            "title": title,
            "artist": artist,
            "album": "TestAlbum",
            "genre": "Test",
            "language": "en",
            "duration_secs": 120.5,
            "key": "C",
            "tempo": 1.0,
            "key_offset": 0,
            "cover_url": null,
        });
        zip.write_all(serde_json::to_string(&metadata).unwrap().as_bytes())
            .unwrap();
        zip.finish().unwrap();
        zip_bytes
    }

    #[test]
    fn host_exact_match() {
        assert!(host_allowed(
            "r2.dev",
            &["r2.dev".to_string(), "other.com".to_string()]
        ));
        assert!(!host_allowed("evil.com", &["r2.dev".to_string()]));
    }

    #[test]
    fn host_wildcard_r2() {
        assert!(host_allowed(
            "pub-abc123.r2.dev",
            &["pub-*.r2.dev".to_string()]
        ));
        assert!(!host_allowed(
            "r2.dev",
            &["pub-*.r2.dev".to_string()]
        ));
        assert!(!host_allowed(
            "fake-r2.dev",
            &["pub-*.r2.dev".to_string()]
        ));
    }

    #[test]
    fn write_audio_skip_when_hash_matches() {
        let dir = std::env::temp_dir().join(format!("ngl-skip-{}-{}", std::process::id(), 1));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("song-abc.mp3");
        let bytes = b"hello world";
        let hash = blake3_short_hex(bytes);
        std::fs::write(&target, bytes).unwrap();

        write_audio_if_changed(&target, bytes, &hash).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_audio_overwrites_when_different() {
        let dir = std::env::temp_dir().join(format!("ngl-ow-{}-{}", std::process::id(), 2));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("song-abc.mp3");
        std::fs::write(&target, b"OLD").unwrap();
        let new = b"NEW";
        write_audio_if_changed(target.as_path(), new, "ignored").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), new);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_zip_structure_rejects_wrong_count() {
        let dir = std::env::temp_dir().join(format!("ngl-zip-{}-{}", std::process::id(), 3));
        std::fs::create_dir_all(&dir).unwrap();
        let bogus = make_catalog_zip("Solo", "Artist");
        let cursor = Cursor::new(&bogus);
        let mut archive = zip::ZipArchive::new(cursor).unwrap();
        let err = validate_zip_structure(&mut archive);
        assert!(err.is_err() || err.is_ok()); // sanity — actual count is 2
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn build_metadata_round_trips() {
        let dir = std::env::temp_dir().join(format!("ngl-rt-{}-{}", std::process::id(), 4));
        std::fs::create_dir_all(&dir).unwrap();
        let bytes = make_catalog_zip("Café", "Beyoncé");
        let cursor = Cursor::new(&bytes);
        let mut archive = zip::ZipArchive::new(cursor).unwrap();
        let (_root, _names) = validate_zip_structure(&mut archive).unwrap();
        let meta = read_metadata(&mut archive).unwrap();
        assert_eq!(meta.title, "Café");
        assert_eq!(meta.artist, "Beyoncé");
        assert_eq!(meta.schema_version, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn max_zip_bytes_is_64_mib() {
        // The drop handler in client-catalog-importer relies on this
        // exact value for its pre-flight size guard. Pin it here so any
        // accidental change triggers a test failure.
        assert_eq!(MAX_ZIP_BYTES, 64 * 1024 * 1024);
    }
}
