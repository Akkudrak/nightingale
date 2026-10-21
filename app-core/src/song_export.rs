use std::path::{Path, PathBuf};

use crate::cache::{CacheDir, normalize_tempo};
use crate::error::NightingaleError;
use crate::library_db;
use crate::nge_format::build_nge;
use crate::song::{NgeSongMeta, Song, SongOrigin};

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

fn build_nge_from_song(song: &Song, cache: &CacheDir) -> Result<Vec<u8>, NightingaleError> {
    if !matches!(song.origin, SongOrigin::LocalFile) {
        return Err(NightingaleError::Other(
            "only local songs can be exported to .nge".into(),
        ));
    }

    let hash = &song.file_hash;
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();

    if let Some((inst, voc)) = resolve_stem_files(song, cache) {
        entries.push((
            stem_entry_name("instrumental", &inst),
            std::fs::read(&inst)?,
        ));
        entries.push((stem_entry_name("vocals", &voc), std::fs::read(&voc)?));
    } else {
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
