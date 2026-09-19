use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::Song;

/// Tagged union mirroring `playbackLocationStateSchema` on the
/// frontend. The `kind` discriminator picks the variant; both
/// variants wrap their payload in a single named field (`song` /
/// `youtube`) so the JSON shape on the wire matches the TS schema
/// exactly.
///
/// `rename_all = "camelCase"` covers both the variant name
/// (`Song` → `song`) and the field names (`queue_playback` →
/// `queuePlayback`, `playback_id` → `playbackId`). The inner
/// `YouTubeTarget` deliberately stays snake_case to match the
/// YouTube Data API response shape and the existing `YouTubeHit`
/// TS type.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PlaybackSession {
    Song {
        // Boxed so the `Song` payload (~300 B of strings + paths) doesn't
        // dominate the enum's footprint and trip `clippy::large_enum_variant`.
        // Serialization is unaffected — `Box<Song>` round-trips through serde
        // exactly like `Song`.
        song: Box<Song>,
        queue_playback: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        playback_id: Option<String>,
    },
    Youtube {
        youtube: YouTubeTarget,
        // Mirrors the `Song` variant: `true` means the session came from
        // the playback queue (the visor should expose a Skip button and
        // surface a Next-video overlay when the embed ends). Direct
        // launches from the search results leave this `false`, which
        // `serde(default)` keeps compatible with older payloads.
        #[serde(default)]
        queue_playback: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        playback_id: Option<String>,
    },
}

/// Lightweight YouTube target that the desktop karaoke visor renders
/// via an embedded `<iframe>`. Mirrors `client/src/types/YouTubeHit.ts`
/// — same five fields, snake_case to match the API response shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YouTubeTarget {
    pub video_id: String,
    pub title: String,
    pub channel_title: String,
    pub thumbnail_url: String,
    pub watch_url: String,
}

#[derive(Debug, Default)]
pub struct PlaybackSessionStore {
    session: Mutex<Option<PlaybackSession>>,
}

impl PlaybackSessionStore {
    pub fn load(&self) -> Result<Option<PlaybackSession>, String> {
        self.session
            .lock()
            .map(|session| session.clone())
            .map_err(|_| "playback session lock poisoned".to_string())
    }

    pub fn save(&self, session: PlaybackSession) -> Result<PlaybackSession, String> {
        let mut current = self
            .session
            .lock()
            .map_err(|_| "playback session lock poisoned".to_string())?;
        *current = Some(session.clone());
        Ok(session)
    }
}
