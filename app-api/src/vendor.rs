use app_core::{CachePaths, SetupFolders};
use serde::Deserialize;
use serde_json::Value;

use crate::{ApiError, CmdResult, EventEmitter};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TriggerSetupArgs {
    #[serde(default)]
    data_path: Option<String>,
    #[serde(default)]
    cache_paths: Option<CachePaths>,
}

pub(crate) fn trigger_setup(events: EventEmitter, payload: Value) -> CmdResult {
    let args: TriggerSetupArgs = if payload.is_null() {
        TriggerSetupArgs {
            data_path: None,
            cache_paths: None,
        }
    } else {
        serde_json::from_value(payload)
            .map_err(|e| ApiError::bad_request(format!("invalid trigger_setup args: {e}")))?
    };

    std::thread::spawn(move || {
        if let Some(paths) = args.cache_paths.as_ref() {
            for path in [&paths.songs, &paths.videos, &paths.models, &paths.vendor]
                .into_iter()
                .flatten()
            {
                if let Err(error) = events.allow_directory(path) {
                    events.emit_value("setup-error", Value::String(error));
                    return;
                }
            }
        }

        let events_for_progress = events.clone();
        let events_for_migration = events.clone();
        if let Err(error) = app_core::run_vendor_setup(
            SetupFolders {
                data_path: args.data_path,
                cache_paths: args.cache_paths,
            },
            move |progress| events_for_progress.emit("setup-progress", &progress),
            move |new_path| events_for_migration.allow_directory(new_path),
        ) {
            events.emit_value("setup-error", Value::String(error));
        }
    });
    Ok(Value::Null)
}
