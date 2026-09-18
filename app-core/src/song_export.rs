//! Self-contained song export/import.
//!
//! Bundles *everything* Nightingale needs to play a song — audio, cover,
//! transcript, stems (mp3 + legacy ogg), lyrics, key/tempo variants, and
//! the playable video — into a single ZIP, so an import on a fresh
//! install can skip the AI re-analysis pipeline (stem separation +
//! transcription).
//!
//! See [PLAN: deep-seeking-gem.md] for the schema and import flow.
//!
//! Scope: only `SongOrigin::LocalFile` songs can be exported; remote
//! origins (Jellyfin / Navidrome / Plex) need a live source server to
//! re-import, so they're rejected up-front.

use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use blake3::Hasher;
use serde::{Deserialize, Serialize};
use zip::CompressionMethod;
use zip::read::ZipArchive;
use zip::write::{FileOptions, ZipWriter};

use crate::cache::CacheDir;
use crate::config::AppConfig;
use crate::error::NightingaleError;
use crate::song::{Song, SongOrigin};

pub const SONG_EXPORT_SCHEMA_VERSION: u32 = 1;
pub const SONG_EXPORT_FORMAT: &str = "nightingale_song";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SongExportMetadata {
    pub schema_version: u32,
    pub format: String,
    pub file_hash: String,
    /// blake3 first-32-hex of the cover bytes. Empty string when the
    /// song has no cover art.
    #[serde(default)]
    pub cover_hash: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_secs: f64,
    pub is_analyzed: bool,
    pub language: Option<String>,
    pub transcript_source: Option<crate::song::TranscriptSource>,
    pub key: Option<String>,
    pub override_key: Option<String>,
    pub tempo: f64,
    pub key_offset: i32,
    pub is_video: bool,
    pub no_stems: bool,
    pub audio_filename: String,
    pub cover_filename: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ImportResult {
    pub song: Song,
    pub imported_path: PathBuf,
}

/// Result of an import triggered by a `nightingale://catalog/v1/import?p=…`
/// deep-link. The desktop side emits this struct as the
/// `deep-link-import-done` Tauri event so the React UI can toast and
/// invalidate its songs query. Mirrors `StemsReady` in shape — a
/// permissive `Option`-heavy struct so future payload additions don't
/// break older desktop builds.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinkImportDone {
    pub ok: bool,
    pub file_hash: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub imported_path: Option<String>,
    pub error: Option<String>,
}

impl DeepLinkImportDone {
    /// Build a failure payload with the given error message; all other
    /// fields are `None`.
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
}

/// Build a Nightingale song ZIP in memory.
///
/// Reads the audio file at `song.path` (verifying it still matches
/// `song.file_hash`), the cover file at `song.album_art_path` (if any),
/// and every entry under `<cache.path>` whose filename starts with
/// `song.file_hash`. Writes them — together with a `metadata.json` —
/// into a single-root ZIP and returns the bytes.
pub fn build_song_export_zip(song: &Song, cache: &CacheDir) -> Result<Vec<u8>, NightingaleError> {
    if !matches!(song.origin, SongOrigin::LocalFile) {
        return Err(NightingaleError::Other(
            "only LocalFile songs can be exported as a full song bundle; \
             remote-origin songs require a live source server"
                .to_string(),
        ));
    }

    let audio_bytes = std::fs::read(&song.path)?;
    let computed_hash = blake3_short_hex(&audio_bytes);
    if computed_hash != song.file_hash {
        return Err(NightingaleError::Other(format!(
            "file_hash mismatch: db says {}, file computes to {}",
            song.file_hash, computed_hash
        )));
    }

    let audio_filename = audio_filename_for(&song.path, song.is_video);

    let (cover_bytes, cover_filename) = match &song.album_art_path {
        Some(p) if p.is_file() => {
            let bytes = std::fs::read(p)?;
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("jpg")
                .to_ascii_lowercase();
            (Some(bytes), Some(format!("cover.{}", ext)))
        }
        _ => (None, None),
    };
    let cover_hash = cover_bytes
        .as_deref()
        .map(blake3_short_hex)
        .unwrap_or_default();

    let mut cache_entries: Vec<(String, PathBuf)> = Vec::new();
    if let Ok(read_dir) = std::fs::read_dir(&cache.path) {
        for entry in read_dir.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !name.starts_with(&song.file_hash) {
                continue;
            }
            if !path.is_file() {
                continue;
            }
            cache_entries.push((format!("cache/{}", name), path));
        }
    }
    let playable_video = cache.playable_video_path(&song.file_hash);
    if playable_video.is_file() {
        // playable_video_path returns <cache>/playable_videos/{hash}.mp4
        let basename = playable_video
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("video.mp4")
            .to_string();
        cache_entries.push((
            format!("cache/playable_videos/{}", basename),
            playable_video,
        ));
    }

    let metadata = SongExportMetadata {
        schema_version: SONG_EXPORT_SCHEMA_VERSION,
        format: SONG_EXPORT_FORMAT.to_string(),
        file_hash: song.file_hash.clone(),
        cover_hash,
        title: song.title.clone(),
        artist: song.artist.clone(),
        album: song.album.clone(),
        duration_secs: song.duration_secs,
        is_analyzed: song.is_analyzed,
        language: song.language.clone(),
        transcript_source: song.transcript_source,
        key: song.key.clone(),
        override_key: song.override_key.clone(),
        tempo: song.tempo,
        key_offset: song.key_offset,
        is_video: song.is_video,
        no_stems: song.no_stems,
        audio_filename: audio_filename.clone(),
        cover_filename,
    };

    let cursor = Cursor::new(Vec::<u8>::new());
    let mut zip = ZipWriter::new(cursor);
    let opts = || -> FileOptions<'static, ()> {
        FileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .large_file(true)
    };

    zip.start_file(&audio_filename, opts())
        .map_err(zip_err_to_nightingale)?;
    zip.write_all(&audio_bytes)?;

    if let (Some(bytes), Some(name)) = (&cover_bytes, &metadata.cover_filename) {
        zip.start_file(name, opts())
            .map_err(zip_err_to_nightingale)?;
        zip.write_all(bytes)?;
    }

    let metadata_json = serde_json::to_vec(&metadata)
        .map_err(|e| NightingaleError::Other(format!("metadata serialize: {e}")))?;
    zip.start_file("metadata.json", opts())
        .map_err(zip_err_to_nightingale)?;
    zip.write_all(&metadata_json)?;

    for (zip_name, src) in &cache_entries {
        zip.start_file(zip_name, opts())
            .map_err(zip_err_to_nightingale)?;
        let bytes = std::fs::read(src)?;
        zip.write_all(&bytes)?;
    }

    let cursor = zip.finish().map_err(zip_err_to_nightingale)?;
    Ok(cursor.into_inner())
}

/// Restore a song from a Nightingale song ZIP.
///
/// If a row with the same `file_hash` already exists it's overwritten;
/// otherwise the song is appended. The audio is dropped at
/// `target_library_dir/<title>-<artist>-<hash12>.<ext>` (sanitized) and
/// every cache entry under `cache/` in the ZIP is materialised into
/// `<cache.path>` (with a zip-slip guard).
///
/// When `target_library_dir` is `None`, the function falls back to the
/// active `AppConfig.library_source` folder (if any). If neither is set,
/// an error is returned so the caller can prompt the user.
pub fn import_song_export_zip(
    zip_bytes: &[u8],
    target_library_dir: Option<&Path>,
    cache: &CacheDir,
) -> Result<ImportResult, NightingaleError> {
    let restored = extract_song_export_zip(zip_bytes, cache)?;

    let library_dir = resolve_library_dir(target_library_dir)?;
    std::fs::create_dir_all(&library_dir)?;
    let ext = Path::new(&restored.metadata.audio_filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or(if restored.metadata.is_video {
            "mp4"
        } else {
            "mp3"
        });
    let sanitized = sanitize_filename(&restored.metadata.title, &restored.metadata.artist);
    let target_filename = format!(
        "{}-{}.{}",
        sanitized,
        &restored.metadata.file_hash[..12],
        ext
    );
    let imported_path = library_dir.join(&target_filename);
    std::fs::write(&imported_path, &restored.audio_bytes)?;

    std::fs::create_dir_all(&cache.path)?;
    if let Some(bytes) = &restored.cover_bytes {
        let cover_hash = blake3_short_hex(bytes);
        let cover_path = cache.cover_path(&cover_hash);
        std::fs::write(&cover_path, bytes)?;
    }
    write_cache_entries_from_memory(
        &restored.cache_entries,
        &cache.path,
        &restored.metadata.file_hash,
    )?;

    let album_art_path = restored
        .cover_bytes
        .as_ref()
        .map(|bytes| cache.cover_path(&blake3_short_hex(bytes)));

    let song = Song {
        path: imported_path.clone(),
        file_hash: restored.metadata.file_hash.clone(),
        title: restored.metadata.title.clone(),
        artist: restored.metadata.artist.clone(),
        album: restored.metadata.album.clone(),
        duration_secs: restored.metadata.duration_secs,
        album_art_path,
        is_analyzed: restored.metadata.is_analyzed,
        language: restored.metadata.language.clone(),
        transcript_source: restored.metadata.transcript_source,
        key: restored.metadata.key.clone(),
        override_key: restored.metadata.override_key.clone(),
        tempo: restored.metadata.tempo,
        key_offset: restored.metadata.key_offset,
        is_video: restored.metadata.is_video,
        usdx: None,
        origin: SongOrigin::LocalFile,
        no_stems: restored.metadata.no_stems,
        genre: None,
        added_at: 0,
    };

    upsert_song(&song)?;

    Ok(ImportResult {
        song,
        imported_path,
    })
}

/// File-only counterpart of [`import_song_export_zip`]: reads the ZIP,
/// validates `metadata.json`, verifies the audio / cover hashes, and
/// returns every byte we need to materialise on disk — *without*
/// touching the SQLite library DB. Useful for tests and for callers
/// that want to drive the upsert themselves.
pub struct ExtractedExport {
    pub metadata: SongExportMetadata,
    pub audio_bytes: Vec<u8>,
    pub cover_bytes: Option<Vec<u8>>,
    pub cache_entries: Vec<(String, Vec<u8>)>,
}

pub fn extract_song_export_zip(
    zip_bytes: &[u8],
    _cache: &CacheDir,
) -> Result<ExtractedExport, NightingaleError> {
    let cursor = Cursor::new(zip_bytes);
    let mut archive =
        ZipArchive::new(cursor).map_err(|e| NightingaleError::Other(format!("zip open: {e}")))?;

    let metadata = read_metadata_from_archive(&mut archive)?;
    validate_metadata(&metadata)?;

    let audio_bytes = read_audio_from_archive(&mut archive, &metadata.audio_filename)?;
    let computed_hash = blake3_short_hex(&audio_bytes);
    if computed_hash != metadata.file_hash {
        return Err(NightingaleError::Other(format!(
            "file_hash mismatch: metadata says {}, audio computes to {}",
            metadata.file_hash, computed_hash
        )));
    }

    let cover_bytes = match &metadata.cover_filename {
        Some(name) => read_optional_entry(&mut archive, name)?,
        None => None,
    };
    let computed_cover_hash = cover_bytes
        .as_deref()
        .map(blake3_short_hex)
        .unwrap_or_default();
    if !metadata.cover_hash.is_empty() && metadata.cover_hash != computed_cover_hash {
        return Err(NightingaleError::Other(format!(
            "cover_hash mismatch: metadata says {}, cover computes to {}",
            metadata.cover_hash, computed_cover_hash
        )));
    }

    let mut cache_entries: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| NightingaleError::Other(format!("zip entry: {e}")))?;
        let name = entry.name().to_string();
        let Some(rest) = name.strip_prefix("cache/") else {
            continue;
        };
        if rest.is_empty() {
            continue;
        }
        if rest.contains("..") || rest.starts_with('/') || rest.starts_with('\\') {
            return Err(NightingaleError::Other(format!(
                "refusing to extract entry with unsafe path: {:?}",
                name
            )));
        }
        let bare = rest.rsplit_once('/').map(|(_, t)| t).unwrap_or(rest);
        if !bare.starts_with(&metadata.file_hash) {
            continue;
        }
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| NightingaleError::Other(format!("entry read: {e}")))?;
        cache_entries.push((rest.to_string(), buf));
    }

    Ok(ExtractedExport {
        metadata,
        audio_bytes,
        cover_bytes,
        cache_entries,
    })
}

/// End-to-end export: look the song up by `file_hash`, build the ZIP,
/// write it to `output_path`, and return the byte count. Mirrors
/// [`catalog_export::export_song_to_path`](crate::catalog_export::export_song_to_path)
/// so the Tauri command and headless HTTP endpoint share the same
/// entry point.
pub fn export_song_full_to_path(
    file_hash: &str,
    output_path: &Path,
) -> Result<u64, NightingaleError> {
    let song = crate::library_db::load_song_by_hash(file_hash)
        .map_err(|e| NightingaleError::Other(format!("db lookup: {e}")))?
        .ok_or_else(|| NightingaleError::Other(format!("no song with file_hash {file_hash:?}")))?;
    if !matches!(song.origin, SongOrigin::LocalFile) {
        return Err(NightingaleError::Other(
            "only LocalFile songs can be exported as a full bundle; \
             remote-origin songs require a live source server"
                .to_string(),
        ));
    }
    let cache = CacheDir::new();
    let bytes = build_song_export_zip(&song, &cache)?;
    std::fs::write(output_path, &bytes)?;
    Ok(bytes.len() as u64)
}

/// End-to-end import: read the ZIP at `zip_path`, restore the song +
/// cache files into the active library / cache dirs, insert or update
/// the SQLite row, and return the resulting `Song` plus the audio's
/// final filesystem path. Mirrors `export_song_full_to_path` above.
pub fn import_song_full_from_path(
    zip_path: &Path,
    target_library_dir: Option<&Path>,
) -> Result<ImportResult, NightingaleError> {
    let bytes = std::fs::read(zip_path)?;
    let cache = CacheDir::new();
    import_song_export_zip(&bytes, target_library_dir, &cache)
}

fn read_metadata_from_archive<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<SongExportMetadata, NightingaleError> {
    let mut metadata_bytes: Option<Vec<u8>> = None;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| NightingaleError::Other(format!("zip entry: {e}")))?;
        let name = entry.name().to_string();
        let bare = name.rsplit_once('/').map(|(_, t)| t).unwrap_or(&name);
        if bare == "metadata.json" {
            let mut buf = Vec::new();
            entry
                .read_to_end(&mut buf)
                .map_err(|e| NightingaleError::Other(format!("metadata read: {e}")))?;
            metadata_bytes = Some(buf);
            break;
        }
    }
    let bytes = metadata_bytes
        .ok_or_else(|| NightingaleError::Other("metadata.json not found in zip".into()))?;
    serde_json::from_slice(&bytes)
        .map_err(|e| NightingaleError::Other(format!("metadata.json parse: {e}")))
}

fn validate_metadata(m: &SongExportMetadata) -> Result<(), NightingaleError> {
    if m.format != SONG_EXPORT_FORMAT {
        return Err(NightingaleError::Other(format!(
            "unsupported format: {:?} (expected {:?})",
            m.format, SONG_EXPORT_FORMAT
        )));
    }
    if m.schema_version != SONG_EXPORT_SCHEMA_VERSION {
        return Err(NightingaleError::Other(format!(
            "unsupported schema_version: {} (expected {})",
            m.schema_version, SONG_EXPORT_SCHEMA_VERSION
        )));
    }
    if m.file_hash.len() < 12 {
        return Err(NightingaleError::Other(format!(
            "file_hash too short: {:?}",
            m.file_hash
        )));
    }
    Ok(())
}

fn read_audio_from_archive<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    audio_filename: &str,
) -> Result<Vec<u8>, NightingaleError> {
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| NightingaleError::Other(format!("zip entry: {e}")))?;
        let name = entry.name().to_string();
        let bare = name.rsplit_once('/').map(|(_, t)| t).unwrap_or(&name);
        if bare == audio_filename {
            let mut buf = Vec::new();
            entry
                .read_to_end(&mut buf)
                .map_err(|e| NightingaleError::Other(format!("audio read: {e}")))?;
            return Ok(buf);
        }
    }
    Err(NightingaleError::Other(format!(
        "audio file {:?} not found in zip",
        audio_filename
    )))
}

fn read_optional_entry<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    filename: &str,
) -> Result<Option<Vec<u8>>, NightingaleError> {
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| NightingaleError::Other(format!("zip entry: {e}")))?;
        let name = entry.name().to_string();
        let bare = name.rsplit_once('/').map(|(_, t)| t).unwrap_or(&name);
        if bare == filename {
            let mut buf = Vec::new();
            entry
                .read_to_end(&mut buf)
                .map_err(|e| NightingaleError::Other(format!("entry read: {e}")))?;
            return Ok(Some(buf));
        }
    }
    Ok(None)
}

fn write_cache_entries_from_memory(
    entries: &[(String, Vec<u8>)],
    cache_dir: &Path,
    file_hash: &str,
) -> Result<(), NightingaleError> {
    std::fs::create_dir_all(cache_dir)?;
    for (rest, bytes) in entries {
        if !rest.starts_with(file_hash) {
            continue;
        }
        let dst = cache_dir.join(rest);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&dst, bytes)?;
    }
    Ok(())
}

fn resolve_library_dir(target: Option<&Path>) -> Result<PathBuf, NightingaleError> {
    if let Some(p) = target {
        return Ok(p.to_path_buf());
    }
    let cfg = AppConfig::load();
    match cfg.library_source.as_ref() {
        Some(crate::LibrarySource::Folder { path }) => Ok(path.clone()),
        _ => Err(NightingaleError::Other(
            "no target library folder provided and AppConfig has no folder library_source; \
             pass target_library_dir or configure one"
                .into(),
        )),
    }
}

fn upsert_song(song: &Song) -> Result<(), NightingaleError> {
    let existing = crate::library_db::load_song_by_hash(&song.file_hash)
        .map_err(|e| NightingaleError::Other(format!("db lookup: {e}")))?;
    if existing.is_some() {
        crate::library_db::update_song_fields(&song.file_hash, song)
            .map_err(|e| NightingaleError::Other(format!("db update: {e}")))?;
    } else {
        crate::library_db::append_songs(std::slice::from_ref(song))
            .map_err(|e| NightingaleError::Other(format!("db insert: {e}")))?;
    }
    Ok(())
}

fn blake3_short_hex(bytes: &[u8]) -> String {
    let mut hasher = Hasher::new();
    hasher.update(bytes);
    hasher.finalize().to_hex()[..32].to_string()
}

fn audio_filename_for(path: &Path, is_video: bool) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or(if is_video { "mp4" } else { "mp3" })
        .to_ascii_lowercase();
    format!("audio.{}", ext)
}

fn sanitize_filename(title: &str, artist: &str) -> String {
    let combined = format!("{title}-{artist}");
    let mut slug: String = combined
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    let trimmed = slug.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "song".to_string()
    } else {
        trimmed
    }
}

fn zip_err_to_nightingale(e: zip::result::ZipError) -> NightingaleError {
    NightingaleError::Other(e.to_string())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)] // tests panic on failure by design
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_subdir(label: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        dir.push(format!("ngl-song-export-{label}-{stamp}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fake_song(audio_path: PathBuf, file_hash: String) -> Song {
        Song {
            path: audio_path,
            file_hash,
            title: "Pierdete Conmigo".into(),
            artist: "Elefante".into(),
            album: "Album".into(),
            duration_secs: 213.7,
            album_art_path: None,
            is_analyzed: true,
            language: Some("es".into()),
            transcript_source: Some(crate::song::TranscriptSource::Generated),
            key: Some("Am".into()),
            override_key: Some("C".into()),
            tempo: 120.0,
            key_offset: 0,
            is_video: false,
            usdx: None,
            origin: SongOrigin::LocalFile,
            no_stems: false,
            genre: None,
            added_at: 0,
        }
    }

    fn blake3_of_bytes(bytes: &[u8]) -> String {
        blake3_short_hex(bytes)
    }

    #[test]
    fn slug_lowercases_and_strips_unsafe_chars() {
        let s = sanitize_filename("Pierdete Conmigo", "Elefante!");
        assert_eq!(s, "pierdete-conmigo-elefante");
    }

    #[test]
    fn slug_falls_back_when_punctuation_only() {
        let s = sanitize_filename("!!!", "???");
        assert_eq!(s, "song");
    }

    #[test]
    fn round_trip_export_import_restores_song_fields() {
        let work = temp_subdir("roundtrip");
        let cache = CacheDir {
            path: work.join("cache"),
        };
        let library = work.join("library");
        fs::create_dir_all(&cache.path).unwrap();
        fs::create_dir_all(&library).unwrap();

        // Audio: real bytes, hash them up-front.
        let audio_path = cache.path.join("source.mp3");
        let audio_bytes: Vec<u8> = (0..4096u32).map(|n| (n % 251) as u8).collect();
        fs::write(&audio_path, &audio_bytes).unwrap();
        let file_hash = blake3_of_bytes(&audio_bytes);

        // Cover.
        let cover_path = cache.path.join("cover-source.jpg");
        let cover_bytes: Vec<u8> = b"jpeg-bytes-here".to_vec();
        fs::write(&cover_path, &cover_bytes).unwrap();

        // Transcript + stems.
        let transcript = cache.path.join(format!("{file_hash}_transcript.json"));
        let transcript_bytes = br#"{"language":"es","source":"generated"}"#;
        fs::write(&transcript, transcript_bytes).unwrap();
        let instrumental = cache.path.join(format!("{file_hash}_instrumental.mp3"));
        let vocals = cache.path.join(format!("{file_hash}_vocals.mp3"));
        fs::write(&instrumental, b"instr").unwrap();
        fs::write(&vocals, b"voc").unwrap();

        // Foreign hash cache file: must NOT be included.
        let foreign = cache.path.join("deadbeefcafebabe_cover.jpg");
        fs::write(&foreign, b"other").unwrap();

        let mut song = fake_song(audio_path.clone(), file_hash.clone());
        song.album_art_path = Some(cover_path.clone());

        let zip_bytes = build_song_export_zip(&song, &cache).expect("export");

        // Drive the file-only extract path so we don't need the library DB.
        let cache2 = CacheDir {
            path: work.join("cache2"),
        };
        fs::create_dir_all(&cache2.path).unwrap();
        let extracted = extract_song_export_zip(&zip_bytes, &cache2).expect("extract");

        // Audio + cover hashes round-tripped.
        assert_eq!(extracted.metadata.file_hash, file_hash);
        assert_eq!(extracted.metadata.cover_hash, blake3_of_bytes(&cover_bytes));
        assert_eq!(extracted.audio_bytes, audio_bytes);
        assert_eq!(
            extracted.cover_bytes.as_deref(),
            Some(cover_bytes.as_slice())
        );
        assert_eq!(extracted.metadata.title, "Pierdete Conmigo");
        assert_eq!(extracted.metadata.override_key.as_deref(), Some("C"));
        assert_eq!(extracted.metadata.tempo, 120.0);
        assert!(extracted.metadata.is_analyzed);

        // Foreign cache file must NOT appear in the extracted entries.
        let has_foreign = extracted
            .cache_entries
            .iter()
            .any(|(name, _)| name.contains("deadbeefcafebabe"));
        assert!(!has_foreign, "foreign cache entry leaked into export");

        // Restore the cache entries onto a fresh dir and confirm bytes.
        write_cache_entries_from_memory(&extracted.cache_entries, &cache2.path, &file_hash)
            .expect("write cache entries");
        let written_transcript = cache2.path.join(format!("{file_hash}_transcript.json"));
        assert_eq!(fs::read(&written_transcript).unwrap(), transcript_bytes);
        let written_instr = cache2.path.join(format!("{file_hash}_instrumental.mp3"));
        assert_eq!(fs::read(&written_instr).unwrap(), b"instr");
        let written_voc = cache2.path.join(format!("{file_hash}_vocals.mp3"));
        assert_eq!(fs::read(&written_voc).unwrap(), b"voc");

        // Cover landed at the content-addressed path.
        let cover_hash = blake3_of_bytes(&cover_bytes);
        let expected_cover = cache2.cover_path(&cover_hash);
        fs::write(&expected_cover, &cover_bytes).unwrap();
        assert_eq!(fs::read(&expected_cover).unwrap(), cover_bytes);

        fs::remove_dir_all(&work).ok();
    }

    #[test]
    fn rejects_audio_with_wrong_hash() {
        let work = temp_subdir("wronghash");
        let cache = CacheDir {
            path: work.join("cache"),
        };
        fs::create_dir_all(&cache.path).unwrap();

        let audio_path = cache.path.join("source.mp3");
        fs::write(&audio_path, b"real bytes").unwrap();

        let wrong_hash = "0".repeat(32);
        let song = fake_song(audio_path, wrong_hash.clone());

        let result = build_song_export_zip(&song, &cache);
        assert!(result.is_err(), "expected hash mismatch error");

        fs::remove_dir_all(&work).ok();
    }

    #[test]
    fn rejects_unsupported_format() {
        let cursor = Cursor::new(Vec::<u8>::new());
        let mut zip = ZipWriter::new(cursor);
        let opts: FileOptions<'static, ()> = FileOptions::default();
        zip.start_file("metadata.json", opts).unwrap();
        let bad = serde_json::json!({
            "schema_version": 1,
            "format": "something_else",
            "file_hash": "deadbeefdeadbeefdeadbeefdeadbeef",
            "title": "x", "artist": "y", "album": "z",
            "duration_secs": 1.0, "is_analyzed": false,
            "language": null, "transcript_source": null,
            "key": null, "override_key": null, "tempo": 1.0,
            "key_offset": 0, "is_video": false, "no_stems": false,
            "audio_filename": "audio.mp3", "cover_filename": null
        });
        zip.write_all(serde_json::to_vec(&bad).unwrap().as_slice())
            .unwrap();
        let bytes = zip.finish().unwrap().into_inner();

        let cache = CacheDir {
            path: work_path("badformat"),
        };
        fs::create_dir_all(&cache.path).unwrap();
        let result = import_song_export_zip(&bytes, None, &cache);
        assert!(result.is_err());
    }

    fn work_path(label: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        dir.push(format!("ngl-song-export-{label}-{stamp}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rejects_zip_slip_entry() {
        // Craft a ZIP whose metadata is valid but a `cache/` entry tries
        // to escape via `..`.
        let audio_bytes = b"abc";
        let file_hash = blake3_of_bytes(audio_bytes);

        let cursor = Cursor::new(Vec::<u8>::new());
        let mut zip = ZipWriter::new(cursor);
        let opts: FileOptions<'static, ()> =
            FileOptions::default().compression_method(CompressionMethod::Stored);

        let meta = SongExportMetadata {
            schema_version: SONG_EXPORT_SCHEMA_VERSION,
            format: SONG_EXPORT_FORMAT.to_string(),
            file_hash: file_hash.clone(),
            cover_hash: String::new(),
            title: "t".into(),
            artist: "a".into(),
            album: "al".into(),
            duration_secs: 1.0,
            is_analyzed: false,
            language: None,
            transcript_source: None,
            key: None,
            override_key: None,
            tempo: 1.0,
            key_offset: 0,
            is_video: false,
            no_stems: false,
            audio_filename: "audio.mp3".into(),
            cover_filename: None,
        };
        zip.start_file("metadata.json", opts).unwrap();
        zip.write_all(&serde_json::to_vec(&meta).unwrap()).unwrap();

        zip.start_file("audio.mp3", opts).unwrap();
        zip.write_all(audio_bytes).unwrap();

        zip.start_file(format!("cache/../{file_hash}_escape.txt"), opts)
            .unwrap();
        zip.write_all(b"pwned").unwrap();

        let bytes = zip.finish().unwrap().into_inner();

        let work = work_path("zipslip");
        let cache = CacheDir {
            path: work.join("cache"),
        };
        fs::create_dir_all(&cache.path).unwrap();
        let result = import_song_export_zip(&bytes, Some(&work), &cache);
        assert!(result.is_err());
    }
}
