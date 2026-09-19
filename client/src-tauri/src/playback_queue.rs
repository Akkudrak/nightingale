use app_core::{PlaybackQueue, PlaybackQueueEntry, QueueItemInput, YouTubeTarget};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};

const QUEUE_CHANGED_EVENT: &str = "playback-queue-changed";

fn emit_queue(app: &AppHandle, entries: &[PlaybackQueueEntry]) -> Result<(), String> {
    app.emit(QUEUE_CHANGED_EVENT, entries)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn load_playback_queue(
    queue: State<'_, PlaybackQueue>,
) -> Result<Vec<PlaybackQueueEntry>, String> {
    queue.entries()
}

/// Tagged payload that mirrors the discriminated `PlaybackQueueEntry`
/// enum on the Rust side and the `addPlaybackQueueEntry` bridge
/// signature on the TS side. `rename_all = "camelCase"` keeps the
/// on-the-wire field names consistent with the rest of the bridge
/// (`fileHash`, `keyOffset`, `addedBy`, `videoId`, …).
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum AddQueueEntryArgs {
    Song {
        file_hash: String,
        tempo: f64,
        key_offset: i32,
        #[serde(default)]
        added_by: Option<String>,
    },
    Youtube {
        youtube: YouTubeTarget,
        #[serde(default)]
        added_by: Option<String>,
    },
}

#[tauri::command]
pub(crate) fn add_playback_queue_entry(
    app: AppHandle,
    queue: State<'_, PlaybackQueue>,
    args: AddQueueEntryArgs,
) -> Result<Vec<PlaybackQueueEntry>, String> {
    let (input, added_by) = match args {
        AddQueueEntryArgs::Song {
            file_hash,
            tempo,
            key_offset,
            added_by,
        } => (
            QueueItemInput::Song {
                file_hash,
                tempo,
                key_offset,
            },
            added_by,
        ),
        AddQueueEntryArgs::Youtube { youtube, added_by } => {
            (QueueItemInput::Youtube { youtube }, added_by)
        }
    };
    let entries = queue.add(input, added_by)?;
    emit_queue(&app, &entries)?;
    Ok(entries)
}

#[tauri::command]
pub(crate) fn remove_playback_queue_entry(
    app: AppHandle,
    queue: State<'_, PlaybackQueue>,
    id: String,
) -> Result<Vec<PlaybackQueueEntry>, String> {
    let entries = queue.remove(&id)?;
    emit_queue(&app, &entries)?;
    Ok(entries)
}

#[tauri::command]
pub(crate) fn clear_playback_queue(
    app: AppHandle,
    queue: State<'_, PlaybackQueue>,
) -> Result<Vec<PlaybackQueueEntry>, String> {
    let entries = queue.clear()?;
    emit_queue(&app, &entries)?;
    Ok(entries)
}
