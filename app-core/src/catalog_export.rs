//! Export a Nightingale library song as a Nightingale-Catalog-compatible ZIP.
//!
//! The Catalog Laravel API (`nightingale-catalog/api`) accepts a ZIP on
//! `POST /api/admin/songs` whose contents are exactly:
//!
//! ```text
//! <root>/song.mp3
//! <root>/metadata.json     # schema_version: 1 + title/artist/album/genre/language/bpm/year/duration_secs/key/tempo/key_offset/notes/cover_url/credits
//! ```
//!
//! `api/app/Support/ZipValidator.php` enforces that every entry sits under
//! a single root folder and that the two required entries exist.
//!
//! Nightingale's `Song` type does NOT carry every catalog field — `genre`,
//! `bpm`, `year`, `notes`, `cover_url`, and `credits` are written as
//! `null` here. The resulting ZIP is valid Catalog format; the missing
//! fields are editable in the catalog admin's edit form after import.

use std::io::{Cursor, Write};
use std::path::Path;

use serde_json::json;
use zip::CompressionMethod;
use zip::write::{FileOptions, ZipWriter};

use crate::error::NightingaleError;
use crate::library_db::load_song_by_hash;
use crate::song::Song;

/// Schema version stamped on every exported metadata.json. Must match
/// `api/app/Http/Controllers/Admin/SongController.php` line 180.
pub const CATALOG_ZIP_SCHEMA_VERSION: u32 = 1;

/// Build a Catalog-format ZIP in memory.
///
/// Returns the bytes so the caller can decide whether to write them to
/// disk (Tauri command), stream them as an HTTP response (headless
/// server), or hand them to the JS layer for further processing.
///
/// On error the returned `NightingaleError` is suitable for bubbling up
/// to the IPC boundary as a `String`.
pub fn build_catalog_zip(song: &Song) -> Result<Vec<u8>, NightingaleError> {
    let root = slug_root_folder(&song.title, &song.artist);
    let mp3_bytes = std::fs::read(&song.path)?;
    let metadata = build_metadata_json(song);

    zip_into_vec(
        &root,
        "song.mp3",
        &mp3_bytes,
        "metadata.json",
        metadata.as_bytes(),
    )
}

/// Build a `<root>-<6-char-suffix>` string the catalog's `ZipValidator`
/// will accept as a single root folder. Mirrors
/// `SongController::buildSlug()` (lines 587-596) just enough to produce a
/// filesystem-safe, lowercase, dash-separated folder name; the random
/// suffix is a 6-char lowercase a-z0-9 string to avoid slug collisions
/// across exports.
fn slug_root_folder(title: &str, artist: &str) -> String {
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
    let base = if trimmed.is_empty() {
        "song"
    } else {
        trimmed.as_str()
    };
    format!("{base}-{}", rand_suffix(6))
}

/// 6-char lowercase alphanumeric suffix. Good enough for collision
/// avoidance in a single-user export; the catalog's validator doesn't
/// care about uniqueness across archives, only the *structure*.
fn rand_suffix(len: usize) -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut out = String::with_capacity(len);
    for _ in 0..len {
        let idx = rand::random_range(0..ALPHABET.len());
        out.push(ALPHABET[idx] as char);
    }
    out
}

/// Map Nightingale `Song` fields onto the Catalog's `metadata.json`
/// schema. Fields Nightingale doesn't carry (`genre`, `bpm`, `year`,
/// `notes`, `cover_url`, `credits`) are emitted as JSON `null`.
///
/// Notes on each field:
/// - `language` is lowercased to match `SongController::store()` line 184
///   which calls `strtolower` on the incoming language.
/// - `key` prefers the user's `override_key` (the post-shift key) over
///   the analyzed key — same intent as the player surface in
///   `features/playback/.../key-shift.tsx`.
/// - `duration_secs` is rounded to a whole second; the catalog's
///   metadata schema accepts a numeric and downstream UI shows it as an
///   integer.
fn build_metadata_json(song: &Song) -> String {
    let language = song.language.as_deref().map(str::to_lowercase);
    let key = song.override_key.as_deref().or(song.key.as_deref());
    let duration_secs = song.duration_secs.round();

    json!({
        "schema_version": CATALOG_ZIP_SCHEMA_VERSION,
        "title":          &song.title,
        "artist":         &song.artist,
        "album":          &song.album,
        "genre":          null,
        "language":       language,
        "bpm":            null,
        "year":           null,
        "duration_secs":  duration_secs,
        "key":            key,
        "tempo":          song.tempo,
        "key_offset":     song.key_offset,
        "notes":          null,
        "cover_url":      null,
        "credits":        null,
    })
    .to_string()
}

/// Write two files (`name_a`, `name_b`) under a single root folder into
/// an in-memory ZIP. We own both file names so there's no zip-slip risk;
/// `Path` traversal is impossible.
fn zip_into_vec(
    root: &str,
    name_a: &str,
    data_a: &[u8],
    name_b: &str,
    data_b: &[u8],
) -> Result<Vec<u8>, NightingaleError> {
    let cursor = Cursor::new(Vec::<u8>::new());
    let mut writer = ZipWriter::new(cursor);

    let opts = || -> FileOptions<'static, ()> {
        FileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .large_file(true)
    };

    writer
        .start_file(format!("{root}/{name_a}"), opts())
        .map_err(zip_to_error)?;
    writer.write_all(data_a).map_err(NightingaleError::from)?;
    writer
        .start_file(format!("{root}/{name_b}"), opts())
        .map_err(zip_to_error)?;
    writer.write_all(data_b).map_err(NightingaleError::from)?;

    let cursor = writer.finish().map_err(zip_to_error)?;
    Ok(cursor.into_inner())
}

/// `zip::result::ZipError` doesn't impl `std::error::Error` in a way our
/// `NightingaleError` From-impl can catch — convert it via `Display`.
fn zip_to_error(e: zip::result::ZipError) -> NightingaleError {
    NightingaleError::Other(e.to_string())
}

/// Convenience: build the ZIP and write it straight to `output_path`.
/// Used by the Tauri command and the headless server endpoint.
pub fn write_catalog_zip_to(song: &Song, output_path: &Path) -> Result<u64, NightingaleError> {
    let bytes = build_catalog_zip(song)?;
    std::fs::write(output_path, &bytes)?;
    Ok(bytes.len() as u64)
}

/// End-to-end entry point: look up the song by its blake3 `file_hash`
/// in the SQLite library DB, build the ZIP, and write it to
/// `output_path`. This is the function the Tauri command and the
/// headless server endpoint both call — it keeps `library_db` private
/// while exposing the full action through `catalog_export`.
pub fn export_song_to_path(file_hash: &str, output_path: &Path) -> Result<u64, NightingaleError> {
    let song = load_song_by_hash(file_hash)
        .map_err(|e| NightingaleError::Other(e.to_string()))?
        .ok_or_else(|| NightingaleError::Other(format!("no song with file_hash {file_hash:?}")))?;
    write_catalog_zip_to(&song, output_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(title: &str, artist: &str) -> Song {
        Song {
            path: PathBuf::from("/tmp/fake.mp3"),
            file_hash: "deadbeef".into(),
            title: title.into(),
            artist: artist.into(),
            album: "Album".into(),
            duration_secs: 213.7,
            album_art_path: None,
            is_analyzed: true,
            language: Some("EN".into()),
            transcript_source: None,
            key: Some("Am".into()),
            override_key: Some("C".into()),
            tempo: 120.0,
            key_offset: 0,
            is_video: false,
            usdx: None,
            origin: crate::song::SongOrigin::LocalFile,
            no_stems: false,
            genre: None,
            added_at: 0,
        }
    }

    #[test]
    fn slug_only_keeps_safe_chars_and_lowercases() {
        let slug = slug_root_folder("Pierdete Conmigo", "Elefante!");
        // Non-ASCII letters (e.g. é, ñ) are flattened to `-` so the slug
        // stays portable across filesystems; the suffix is 6 chars.
        assert!(
            slug.starts_with("pierdete-conmigo-elefante-"),
            "got: {slug}"
        );
        assert_eq!(slug.len(), "pierdete-conmigo-elefante-".len() + 6);
    }

    #[test]
    fn slug_falls_back_when_everything_is_punctuation() {
        let slug = slug_root_folder("!!!", "???");
        assert!(slug.starts_with("song-"));
    }

    #[test]
    fn metadata_prefers_override_key_and_lowercases_language() {
        let song = fixture("Title", "Artist");
        let parsed: serde_json::Value =
            serde_json::from_str(&build_metadata_json(&song)).expect("valid json");
        assert_eq!(parsed["schema_version"], json!(1));
        assert_eq!(parsed["title"], "Title");
        assert_eq!(parsed["key"], "C");
        assert_eq!(parsed["language"], "en");
        assert_eq!(parsed["duration_secs"], 214.0);
        assert_eq!(parsed["genre"], serde_json::Value::Null);
        assert_eq!(parsed["bpm"], serde_json::Value::Null);
        assert_eq!(parsed["year"], serde_json::Value::Null);
        assert_eq!(parsed["notes"], serde_json::Value::Null);
        assert_eq!(parsed["cover_url"], serde_json::Value::Null);
        assert_eq!(parsed["credits"], serde_json::Value::Null);
    }

    /// Round-trip the produced bytes back through the `zip` crate and
    /// confirm the layout matches what the catalog's `ZipValidator`
    /// accepts: a single root folder, exactly two entries (`song.mp3`
    /// and `metadata.json`) directly under it, and a parseable JSON
    /// payload.
    #[test]
    fn zip_has_single_root_with_two_required_entries() {
        let mut song = fixture("Title", "Artist");
        // Point at a real temp file so `build_catalog_zip` can read it.
        let mp3_path = std::env::temp_dir().join("ngl-test-catalog-export.mp3");
        std::fs::write(&mp3_path, b"ID3 fake mp3 bytes").expect("write temp");
        song.path = mp3_path.clone();

        let bytes = build_catalog_zip(&song).expect("zip builds");

        let cursor = Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(cursor).expect("zip opens");
        assert_eq!(archive.len(), 2, "expected exactly two entries");

        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.name_for_index(i).expect("name").to_string())
            .collect();

        // Both entries must share the same root folder.
        let roots: std::collections::HashSet<&str> = names
            .iter()
            .map(|n| n.split_once('/').map(|(root, _)| root).unwrap_or(""))
            .collect();
        assert_eq!(
            roots.len(),
            1,
            "single root folder required, got: {names:?}"
        );
        let root = roots.into_iter().next().expect("non-empty");

        assert!(names.contains(&format!("{root}/song.mp3")));
        assert!(names.contains(&format!("{root}/metadata.json")));

        // Read metadata.json back and confirm it's parseable.
        let mut meta_entry = archive
            .by_name(&format!("{root}/metadata.json"))
            .expect("metadata entry");
        let mut s = String::new();
        use std::io::Read;
        meta_entry.read_to_string(&mut s).expect("read metadata");
        let parsed: serde_json::Value = serde_json::from_str(&s).expect("metadata json");
        assert_eq!(parsed["schema_version"], json!(1));
        assert_eq!(parsed["title"], "Title");

        std::fs::remove_file(&mp3_path).ok();
    }
}
