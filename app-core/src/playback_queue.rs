use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::{Song, SongsStore, YouTubeTarget};

/// Tagged union mirroring `playbackQueueEntrySchema` on the frontend.
///
/// `kind: "song"` carries a full `Song` plus tempo/key offsets so the
/// playback pipeline can shift audio before launch. `kind: "youtube"`
/// skips the audio engine entirely — the karaoke visor embeds the
/// YouTube `<iframe>` and streams the video from YouTube directly, so
/// no tempo/key/tempo fields are relevant.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PlaybackQueueEntry {
    Song {
        id: String,
        // Boxed to keep the enum's footprint reasonable (the `Song` payload
        // is ~300 B of strings + paths; the `Youtube` variant is a flat 168 B).
        // Serialization is identical to `Song` via serde — the box is just
        // indirection on the wire-irrelevant side.
        song: Box<Song>,
        tempo: f64,
        key_offset: i32,
        // Profile that queued the song, when known. `serde(default)` keeps
        // backward compatibility with clients that predate this field.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        added_by: Option<String>,
    },
    Youtube {
        id: String,
        youtube: YouTubeTarget,
        // Profile that queued the video. Same defaultability rule as the
        // song variant.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        added_by: Option<String>,
    },
}

impl PlaybackQueueEntry {
    /// Server-assigned id, regardless of variant. Used by `remove` and
    /// by the React `key` in the frontend queue list.
    pub fn id(&self) -> &str {
        match self {
            Self::Song { id, .. } | Self::Youtube { id, .. } => id,
        }
    }
}

/// Discriminated input for `PlaybackQueue::add`. Keeps the song-lookup
/// path (which goes through `SongsStore::load_by_hashes`) separated
/// from the YouTube path (which is just a passthrough). Owned values
/// avoid lifetime gymnastics at the IPC boundary — the dispatcher
/// moves the deserialized payload straight into this struct.
pub enum QueueItemInput {
    Song {
        file_hash: String,
        tempo: f64,
        key_offset: i32,
    },
    Youtube {
        youtube: YouTubeTarget,
    },
}

#[derive(Debug, Default)]
pub struct PlaybackQueue {
    entries: Mutex<VecDeque<PlaybackQueueEntry>>,
    next_id: AtomicU64,
}

impl PlaybackQueue {
    pub fn entries(&self) -> Result<Vec<PlaybackQueueEntry>, String> {
        self.entries
            .lock()
            .map(|entries| entries.iter().cloned().collect())
            .map_err(|_| "playback queue lock poisoned".to_string())
    }

    pub fn add(
        &self,
        input: QueueItemInput,
        added_by: Option<String>,
    ) -> Result<Vec<PlaybackQueueEntry>, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed).to_string();
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "playback queue lock poisoned".to_string())?;

        let entry = match input {
            QueueItemInput::Song {
                file_hash,
                tempo,
                key_offset,
            } => {
                let song = SongsStore::load_by_hashes(&[file_hash])
                    .into_iter()
                    .next()
                    .ok_or_else(|| "song not found".to_string())?;
                PlaybackQueueEntry::Song {
                    id,
                    song: Box::new(song),
                    tempo,
                    key_offset,
                    added_by,
                }
            }
            QueueItemInput::Youtube { youtube } => PlaybackQueueEntry::Youtube {
                id,
                youtube,
                added_by,
            },
        };

        entries.push_back(entry);

        Ok(entries.iter().cloned().collect())
    }

    pub fn remove(&self, id: &str) -> Result<Vec<PlaybackQueueEntry>, String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "playback queue lock poisoned".to_string())?;

        entries.retain(|entry| entry.id() != id);

        Ok(entries.iter().cloned().collect())
    }

    pub fn clear(&self) -> Result<Vec<PlaybackQueueEntry>, String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "playback queue lock poisoned".to_string())?;

        entries.clear();

        Ok(Vec::new())
    }
}
