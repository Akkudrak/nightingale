//! Each open screen's room, mirrored from SingVerse. The screen asks this
//! server every couple of seconds; this server asks SingVerse at most every
//! [`REFRESH`] (with the version it has, so an unchanged room costs little) and
//! starts downloading the songs on stage and up next.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use super::client::ApiError;
use super::fetch::{Prep, SongSource};
use super::SingVerse;

const REFRESH: Duration = Duration::from_millis(2500);
/// The song on stage plus this many waiting ones are downloaded ahead.
const PREFETCH: usize = 2;

struct Cached {
    state: Value,
    version: Option<u64>,
    fetched: Instant,
}

#[derive(Default)]
pub(crate) struct RoomStore {
    rooms: Mutex<HashMap<String, Cached>>,
}

impl RoomStore {
    fn cached(&self, room: &str) -> Option<(Value, Option<u64>, bool)> {
        let rooms = self.rooms.lock().ok()?;
        let cached = rooms.get(room)?;
        Some((
            cached.state.clone(),
            cached.version,
            cached.fetched.elapsed() < REFRESH,
        ))
    }

    /// Stores a full state SingVerse sent (e.g. in answer to start/finish).
    pub(crate) fn store(&self, room: &str, state: Value) {
        let version = state.pointer("/room/version").and_then(Value::as_u64);
        if let Ok(mut rooms) = self.rooms.lock() {
            rooms.insert(
                room.to_string(),
                Cached {
                    state,
                    version,
                    fetched: Instant::now(),
                },
            );
        }
    }

    fn touch(&self, room: &str) {
        if let Ok(mut rooms) = self.rooms.lock() {
            if let Some(cached) = rooms.get_mut(room) {
                cached.fetched = Instant::now();
            }
        }
    }
}

/// The room's state for the screen, refreshed from SingVerse when stale, with
/// each item's bundle status under `prep` (keyed by queue item id).
pub(crate) async fn state(singverse: &SingVerse, room: &str) -> Result<Value, ApiError> {
    let state = match singverse.rooms.cached(room) {
        Some((state, _, true)) => state,
        cached => {
            let version = cached.as_ref().and_then(|(_, version, _)| *version);
            let client = singverse.client.clone();
            let room_id = room.to_string();
            let fetched = tokio::task::spawn_blocking(move || client.room(&room_id, version))
                .await
                .map_err(|e| ApiError::Transport(e.to_string()))?;

            match (fetched, cached) {
                (Ok(Some(fresh)), _) => {
                    singverse.rooms.store(room, fresh.clone());
                    fresh
                }
                (Ok(None), Some((state, _, _))) => {
                    singverse.rooms.touch(room);
                    state
                }
                (Ok(None), None) => {
                    return Err(ApiError::Transport("empty answer from SingVerse".into()))
                }
                // SingVerse briefly unreachable: keep singing with what we know.
                (Err(ApiError::Transport(error)), Some((state, _, _))) => {
                    tracing::warn!(room, "keeping the last room state: {error}");
                    state
                }
                (Err(error), _) => return Err(error),
            }
        }
    };

    Ok(with_preparation(singverse, state))
}

/// Starts downloads for what is on stage and up next, and reports where each stands.
pub(crate) fn with_preparation(singverse: &SingVerse, mut state: Value) -> Value {
    let mut wanted: Vec<&Value> = Vec::new();
    if let Some(current) = state.get("current").filter(|c| !c.is_null()) {
        wanted.push(current);
    }
    if let Some(queue) = state.get("queue").and_then(Value::as_array) {
        wanted.extend(queue.iter().take(PREFETCH));
    }

    let mut prep = Map::new();
    for item in wanted {
        let Some(item_id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(source) = SongSource::from_item(item) else {
            prep.insert(
                item_id.to_string(),
                serde_json::json!({ "status": "failed", "error": "no playable source" }),
            );
            continue;
        };
        let song_id = source.song_id.clone();
        singverse.downloads.ensure(source);
        let status = singverse.downloads.status(&song_id).unwrap_or(Prep::Queued);
        prep.insert(
            item_id.to_string(),
            serde_json::to_value(status).unwrap_or(Value::Null),
        );
    }

    // The screen never needs the .nge links themselves.
    strip_sources(&mut state);
    let qr = state
        .pointer("/room/join_url")
        .and_then(Value::as_str)
        .and_then(|url| app_core::singverse::qr_svg(url).ok());
    if let Some(object) = state.as_object_mut() {
        object.insert("prep".into(), Value::Object(prep));
        object.insert(
            "join_qr_svg".into(),
            qr.map(Value::String).unwrap_or(Value::Null),
        );
    }
    state
}

fn strip_sources(state: &mut Value) {
    let strip = |item: &mut Value| {
        if let Some(object) = item.as_object_mut() {
            object.remove("source");
        }
    };
    if let Some(current) = state.get_mut("current") {
        strip(current);
    }
    for key in ["queue", "recent"] {
        if let Some(items) = state.get_mut(key).and_then(Value::as_array_mut) {
            items.iter_mut().for_each(strip);
        }
    }
}
