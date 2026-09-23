//! Persistent store for karaoke microphone recordings.
//!
//! Each recording owns a single WAV file under the data folder and a row
//! in a small JSON index (`recordings.json`). Index mutations and file writes
//! are intentionally trivial — recordings are append-only in practice and
//! the only deletes happen from the explicit "delete" command.
//!
//! Filenames are derived from the row id (assigned by `RecordingStore::add`)
//! so the index stays the source of truth: even if a stray `.wav` lands in
//! the folder, the UI only shows what `RecordingStore::load` returns.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::cache::{nightingale_dir, profiles_path};

/// Metadata for a single saved recording. The audio bytes themselves live
/// alongside the index as `<id>.wav` inside the data folder.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RecordingRecord {
    pub id: String,
    /// Active profile at save time. Mirrors `ScoreRecord.profile` so the
    /// existing leaderboard/profile views stay consistent.
    pub profile: String,
    pub song_hash: String,
    /// Song title + artist as captured by the client. Stored on the row
    /// itself so the history list can render even after the song entry
    /// in `songs.db` is removed.
    pub song_title: String,
    pub song_artist: String,
    pub score: u32,
    pub duration_secs: f32,
    pub sample_rate: u32,
    /// Unix seconds at which the take ended (matches `ScoreRecord.played_at`
    /// exactly when both rows are written from the same `usePlaybackResult`
    /// call). Defaults to `0` for legacy rows so older recordings still load.
    #[serde(default)]
    pub played_at: u64,
    /// Unix seconds at which the recording was finalised on disk. Kept for
    /// backward compatibility — for new rows this equals `played_at`.
    pub recorded_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RecordingStore {
    #[serde(default)]
    pub recordings: Vec<RecordingRecord>,
}

/// Inputs for adding a recording. `wav_bytes` is the encoded WAV blob from
/// the client; we decode base64 here so the IPC layer stays JSON.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRecordingInput {
    pub song_hash: String,
    pub song_title: String,
    pub song_artist: String,
    pub score: u32,
    pub duration_secs: f32,
    pub sample_rate: u32,
    /// Unix seconds at which the take ended. Used as the join key against
    /// `ScoreRecord.played_at` so the history view can render the recording
    /// chip on the exact score that produced it. The store also reuses it
    /// as `recorded_at` — the events are back-to-back so they're the same
    /// instant in practice.
    pub played_at: u64,
    /// Base64-encoded WAV bytes (little-endian, PCM).
    pub wav_base64: String,
}

impl RecordingStore {
    fn index_path() -> PathBuf {
        // Share the file with the profiles store for ergonomic backups:
        // `cache.rs::profiles_path` already points at the data folder and
        // any tooling that scrubs the data folder will clean both.
        profiles_path()
            .parent()
            .map(|parent| parent.join("recordings.json"))
            .unwrap_or_else(|| nightingale_dir().join("recordings.json"))
    }

    fn recordings_dir() -> PathBuf {
        nightingale_dir().join("recordings")
    }

    fn wav_path(id: &str) -> PathBuf {
        Self::recordings_dir().join(format!("{id}.wav"))
    }

    pub fn load() -> Self {
        let path = Self::index_path();
        if path.is_file() {
            std::fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            Self::default()
        }
    }

    pub fn save(&self) {
        let path = Self::index_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(path, json);
        }
    }

    /// Append a new recording and persist its WAV blob to disk. Returns
    /// the id assigned to the new row so the caller can reference it.
    pub fn add(&mut self, input: AddRecordingInput) -> Result<String, String> {
        // Resolve active profile lazily from the existing profiles store so
        // the recording is always attributed to the same identity that
        // produced the score in the same flow.
        let profile = crate::ProfileStore::load().active.ok_or_else(|| {
            "no active profile — cannot save recording".to_string()
        })?;

        let wav_dir = Self::recordings_dir();
        std::fs::create_dir_all(&wav_dir)
            .map_err(|e| format!("could not create recordings dir: {e}"))?;

        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed).to_string();
        let wav_path = Self::wav_path(&id);

        let bytes = base64::engine::general_purpose::STANDARD
            .decode(input.wav_base64.as_bytes())
            .map_err(|e| format!("invalid WAV payload: {e}"))?;
        std::fs::write(&wav_path, &bytes)
            .map_err(|e| format!("could not write recording: {e}"))?;

        let recorded_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        self.recordings.push(RecordingRecord {
            id: id.clone(),
            profile,
            song_hash: input.song_hash,
            song_title: input.song_title,
            song_artist: input.song_artist,
            score: input.score,
            duration_secs: input.duration_secs,
            sample_rate: input.sample_rate,
            played_at: input.played_at,
            // Take the client-provided timestamp as the source of truth so the
            // recording's join key matches `ScoreRecord.played_at` exactly.
            // Fall back to wall-clock now() for callers that don't supply one.
            recorded_at: if input.played_at > 0 { input.played_at } else { recorded_at },
        });
        self.save();

        Ok(id)
    }

    /// Remove the row and its WAV file. No-op when the id isn't found.
    pub fn delete(&mut self, id: &str) {
        let before = self.recordings.len();
        self.recordings.retain(|r| r.id != id);
        if self.recordings.len() != before {
            // Best-effort: if the file is gone (e.g. already deleted by a
            // prior crash), we still want the row to disappear so the
            // listing stays consistent.
            let path = Self::wav_path(id);
            if path.is_file() {
                let _ = std::fs::remove_file(&path);
            }
            self.save();
        }
    }

    /// Resolve the on-disk path of a recording's WAV blob. `None` when the
    /// id is unknown — callers should treat that as a 404.
    pub fn wav_path_for(id: &str) -> Option<PathBuf> {
        let path = Self::wav_path(id);
        if path.is_file() {
            Some(path)
        } else {
            None
        }
    }

    /// All recordings for a single song, newest first.
    pub fn for_song(&self, song_hash: &str) -> Vec<RecordingRecord> {
        let mut owned: Vec<RecordingRecord> = self
            .recordings
            .iter()
            .filter(|r| r.song_hash == song_hash)
            .cloned()
            .collect();
        owned.sort_by(|a, b| b.recorded_at.cmp(&a.recorded_at));
        owned
    }

    /// All recordings for a single profile, newest first.
    pub fn for_profile(&self, profile: &str) -> Vec<RecordingRecord> {
        let mut owned: Vec<RecordingRecord> = self
            .recordings
            .iter()
            .filter(|r| r.profile == profile)
            .cloned()
            .collect();
        owned.sort_by(|a, b| b.recorded_at.cmp(&a.recorded_at));
        owned
    }
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Internal helper used by the server to read the data dir for recordings.
/// Kept here so the path layout stays in one place.
pub fn recordings_root() -> PathBuf {
    RecordingStore::recordings_dir()
}

/// True when `path` lives inside the recordings root. Used by the server's
/// media route to gate file access.
pub fn is_within_recordings(path: &Path) -> bool {
    match std::fs::canonicalize(path) {
        Ok(canon) => match std::fs::canonicalize(RecordingStore::recordings_dir()) {
            Ok(root) => canon.starts_with(root),
            Err(_) => false,
        },
        Err(_) => false,
    }
}