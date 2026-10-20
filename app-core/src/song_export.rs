//! Export an analyzed library song into a shareable `.nge` bundle.
//!
//! This is the symmetric counterpart of [`crate::song::build_nge_song`]: it
//! gathers the song's audio plus every analysis artifact from the cache and
//! packs them into one `.nge` (a ZIP archive, see [`crate::nge_format`]). Only
//! local-origin songs can be exported — remote (Jellyfin/Navidrome/Plex) songs
//! need a live server to be re-imported, so there is nothing self-contained to
//! ship.

use std::path::{Path, PathBuf};

use crate::cache::{CacheDir, normalize_tempo};
use crate::error::NightingaleError;
use crate::library_db;
use crate::nge_format::build_nge;
use crate::song::{NgeSongMeta, Song, SongOrigin};

/// Resolve the song's actual instrumental/vocals stem files on disk. Stems are
/// stored under several naming schemes depending on how the song was analyzed:
/// a key/tempo variant (the common case — the base stems live at the song's own
/// key), the plain `<hash>_instrumental.mp3`, or legacy `.ogg`. Mirrors the
/// resolution `get_audio_paths` uses so export never silently drops stems.
fn resolve_stem_files(song: &Song, cache: &CacheDir) -> Option<(PathBuf, PathBuf)> {
    let hash = &song.file_hash;
    let tempo = normalize_tempo(song.tempo);

    if let Some(key) = song.override_key.as_deref().or(song.key.as_deref()) {
        let vi = cache.variant_instrumental_path(hash, key, tempo);
        let vv = cache.variant_vocals_path(hash, key, tempo);
        if vi.is_file() && vv.is_file() {
            return Some((vi, vv));
        }
    }

    let i = cache.instrumental_path(hash);
    let v = cache.vocals_path(hash);
    if i.is_file() && v.is_file() {
        return Some((i, v));
    }

    let li = cache.legacy_instrumental_path(hash);
    let lv = cache.legacy_vocals_path(hash);
    if li.is_file() && lv.is_file() {
        return Some((li, lv));
    }

    None
}

fn stem_entry_name(base: &str, path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_else(|| "mp3".to_string());
    format!("{base}.{ext}")
}

/// Build the raw bytes of a `.nge` bundle for `song`, pulling stems, cover,
/// transcript, lyrics and playable video out of `cache` when present.
fn build_nge_from_song(song: &Song, cache: &CacheDir) -> Result<Vec<u8>, NightingaleError> {
    if !matches!(song.origin, SongOrigin::LocalFile) {
        return Err(NightingaleError::Other(
            "only local songs can be exported to .nge".into(),
        ));
    }

    let hash = &song.file_hash;
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();

    if let Some((inst, voc)) = resolve_stem_files(song, cache) {
        // The song has separated stems, which are all playback and scoring ever
        // read. The original mix is redundant (and the single largest entry), so
        // we drop it — a lossless size win. The stems are packed verbatim.
        entries.push((
            stem_entry_name("instrumental", &inst),
            std::fs::read(&inst)?,
        ));
        entries.push((stem_entry_name("vocals", &voc), std::fs::read(&voc)?));
    } else {
        // No stems (e.g. an LRC `no_stems` song): the original mix *is* the only
        // playable track, so it must be packed. Verify it still matches the
        // library record before shipping it.
        let audio_bytes = std::fs::read(&song.path)?;
        let got = blake3::hash(&audio_bytes).to_hex()[..32].to_string();
        if got != song.file_hash {
            return Err(NightingaleError::Other(
                "audio file hash does not match the library record".into(),
            ));
        }
        entries.push((stem_entry_name("audio", &song.path), audio_bytes));
    }

    if let Some(cover) = song.album_art_path.as_ref()
        && cover.is_file()
    {
        entries.push(("cover.jpg".to_string(), std::fs::read(cover)?));
    }

    let transcript = cache.transcript_path(hash);
    if transcript.is_file() {
        entries.push(("transcript.json".to_string(), std::fs::read(&transcript)?));
    }

    let lyrics = cache.lyrics_path(hash);
    if lyrics.is_file() {
        entries.push(("lyrics.json".to_string(), std::fs::read(&lyrics)?));
    }

    let video = cache.playable_video_path(hash);
    if video.is_file() {
        entries.push(("video.mp4".to_string(), std::fs::read(&video)?));
    }

    let metadata = serde_json::to_value(NgeSongMeta::from_song(song))?;
    build_nge(hash, metadata, &entries)
}

/// Export the song with `file_hash` into `dest_dir`, returning the written
/// `.nge` path, named `<artist>_<title>_<random>.nge` (see [`slug_name`]).
pub fn export_song_nge(file_hash: &str, dest_dir: &Path) -> Result<PathBuf, NightingaleError> {
    let song = library_db::load_song_by_hash(file_hash)?
        .ok_or_else(|| NightingaleError::Other("song not found".into()))?;
    let cache = CacheDir::new();
    let bytes = build_nge_from_song(&song, &cache)?;

    std::fs::create_dir_all(dest_dir)?;
    let path = dest_dir.join(format!("{}.nge", slug_name(&song.title, &song.artist)));
    std::fs::write(&path, &bytes)?;
    Ok(path)
}

/// Kebab-case a single field: lowercase ASCII alphanumerics, every other run of
/// characters collapses to a single `-`, trimmed at the ends. Words stay joined
/// by `-` so the `_` separators between fields remain unambiguous.
fn kebab(field: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in field.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// Build the export filename stem: `<artist>_<title>_<random>` — artist first,
/// `_` between fields so the artist and song title stay visually separated
/// (e.g. `artista-banda_nombre-cancion_a1b2c3`). Empty fields are dropped.
fn slug_name(title: &str, artist: &str) -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let suffix: String = (0..6)
        .map(|_| ALPHABET[(rand::random::<u32>() as usize) % ALPHABET.len()] as char)
        .collect();

    let mut parts: Vec<String> = [kebab(artist), kebab(title)]
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect();
    if parts.is_empty() {
        parts.push("song".to_string());
    }
    parts.push(suffix);
    parts.join("_")
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::song::{Song, build_nge_song};

    #[test]
    fn export_then_import_roundtrips() {
        let dir = std::env::temp_dir().join(format!("nge-exp-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let cache = CacheDir {
            path: dir.join("cache"),
        };
        std::fs::create_dir_all(&cache.path).unwrap();

        // A fake "original audio" file; its blake3 is the song's file_hash.
        let audio = vec![7u8; 2048];
        let audio_path = dir.join("song.mp3");
        std::fs::write(&audio_path, &audio).unwrap();
        let file_hash = blake3::hash(&audio).to_hex()[..32].to_string();

        // Fake separated stems in the cache.
        std::fs::write(cache.instrumental_path(&file_hash), vec![1u8; 1000]).unwrap();
        std::fs::write(cache.vocals_path(&file_hash), vec![2u8; 1000]).unwrap();

        let song = Song {
            path: audio_path,
            file_hash: file_hash.clone(),
            title: "Title".into(),
            artist: "Artist".into(),
            album: "Album".into(),
            duration_secs: 1.5,
            album_art_path: None,
            is_analyzed: true,
            language: Some("es".into()),
            transcript_source: None,
            key: Some("Am".into()),
            override_key: None,
            tempo: 1.0,
            key_offset: 0,
            is_video: false,
            usdx: None,
            origin: SongOrigin::LocalFile,
            no_stems: false,
        };

        let bytes = build_nge_from_song(&song, &cache).unwrap();
        let nge_path = dir.join("out.nge");
        std::fs::write(&nge_path, &bytes).unwrap();

        // Importing the bundle reconstructs the song, pointing at the .nge.
        let imported = build_nge_song(&nge_path, &cache).unwrap();
        assert_eq!(imported.file_hash, file_hash);
        assert_eq!(imported.title, "Title");
        assert_eq!(imported.artist, "Artist");
        assert_eq!(imported.key.as_deref(), Some("Am"));
        assert_eq!(imported.path, nge_path);
        assert!(imported.is_analyzed);

        // The bundle carries the stems and, since stems are present, drops the
        // redundant original mix (lossless size win). Entries read back as
        // the exact bytes.
        let nge = crate::nge_format::NgeFile::open(&nge_path).unwrap();
        assert!(nge.manifest.entry("instrumental.mp3").is_some());
        assert!(nge.manifest.entry("vocals.mp3").is_some());
        assert!(nge.manifest.entry("audio.mp3").is_none());
        assert_eq!(nge.read_entry("instrumental.mp3").unwrap(), vec![1u8; 1000]);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn no_stems_song_keeps_original_audio() {
        let dir = std::env::temp_dir().join(format!("nge-nostems-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let cache = CacheDir {
            path: dir.join("cache"),
        };
        std::fs::create_dir_all(&cache.path).unwrap();

        // A `no_stems` song has no separated stems in the cache; the original
        // mix is its only playable track and must be packed.
        let audio = vec![9u8; 4096];
        let audio_path = dir.join("song.mp3");
        std::fs::write(&audio_path, &audio).unwrap();
        let file_hash = blake3::hash(&audio).to_hex()[..32].to_string();

        let song = Song {
            path: audio_path,
            file_hash: file_hash.clone(),
            title: "NoStems".into(),
            artist: "Artist".into(),
            album: "Album".into(),
            duration_secs: 2.0,
            album_art_path: None,
            is_analyzed: true,
            language: None,
            transcript_source: None,
            key: None,
            override_key: None,
            tempo: 1.0,
            key_offset: 0,
            is_video: false,
            usdx: None,
            origin: SongOrigin::LocalFile,
            no_stems: true,
        };

        let bytes = build_nge_from_song(&song, &cache).unwrap();
        let nge_path = dir.join("out.nge");
        std::fs::write(&nge_path, &bytes).unwrap();

        let nge = crate::nge_format::NgeFile::open(&nge_path).unwrap();
        assert!(nge.manifest.entry("audio.mp3").is_some());
        assert!(nge.manifest.entry("instrumental.mp3").is_none());
        assert!(nge.manifest.entry("vocals.mp3").is_none());
        assert_eq!(nge.read_entry("audio.mp3").unwrap(), audio);

        std::fs::remove_dir_all(&dir).ok();
    }
}
