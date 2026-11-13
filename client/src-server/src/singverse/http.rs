//! The HTTP surface in SingVerse mode: the host's entry link, the room API the
//! screen polls, and Nightingale's own playback commands and media, all behind
//! the room session. Anything else redirects to SingVerse.

use std::path::Path;

use axum::{
    body::Body,
    extract::{Path as AxumPath, Query, Request, State},
    http::{header, HeaderMap, StatusCode, Uri},
    middleware,
    response::{IntoResponse, Redirect, Response},
    routing::{any, get, post},
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::Value;

use super::auth::{self, Session};
use super::client::ApiError;
use super::rooms;
use crate::commands::ApiError as CommandApiError;
use crate::media::{self, AssetQuery};
use crate::state::AppState;
use crate::{bootstrap, static_files, ws};

/// The playback screen's needs and nothing more: no library, sources,
/// analyzer, profiles or queue management.
const ROOM_COMMANDS: &[&str] = &[
    "load_config",
    "save_config",
    "load_interface_language",
    "is_ready",
    "load_songs_meta",
    "load_songs_by_hashes",
    "load_profiles",
    "load_lyrics",
    "load_transcript",
    "get_audio_paths",
    "ensure_mp3_stems",
    "ensure_playable_source_video",
    "fetch_pixabay_videos",
    "load_custom_background_shader",
    "resolve_custom_background_path",
    "load_playback_session",
    "load_playback_status",
    "load_playback_progress",
    "load_playback_options",
    "set_playback_status",
    "set_playback_progress",
    "set_playback_options",
    "load_playback_queue",
    "load_remote_microphones",
    "set_remote_microphones",
];

/// Config the screen may not change: where data and songs live and whether
/// the analyzer runs. `save_config` keeps the server's values for these.
const PINNED_CONFIG: &[&str] = &[
    "data_path",
    "cache_paths",
    "last_folder",
    "library_source",
    "auto_analyze",
    "custom_backgrounds",
    "whisper_model",
    "beam_size",
    "batch_size",
    "separator",
    "asr_engine",
    "align_backend",
    "vocal_detection_threshold_pct",
];

/// Media the screen may read through `/api/asset`: bundle entries, cover art,
/// and audio/video/image files. Never configs, the secret seed or databases.
const ASSET_EXTENSIONS: &[&str] = &[
    "mp3", "m4a", "ogg", "opus", "wav", "flac", "mp4", "webm", "mkv", "jpg", "jpeg", "png", "webp",
    "gif", "glsl", "frag",
];

pub(crate) fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/api/bootstrap", get(bootstrap::handle))
        .route("/api/cmd/:name", post(room_cmd))
        .route("/api/asset", get(room_asset))
        .route("/media/:hash/:kind", get(media::handle_hashed))
        .route("/ws", any(ws::handle_upgrade))
        .route("/api/room/:room/state", get(room_state))
        .route("/api/room/:room/start", post(room_start))
        .route("/api/room/:room/finish", post(room_finish))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_session,
        ));

    Router::new()
        .route("/room/:room", get(enter))
        .merge(protected)
        .fallback(fallback)
        .with_state(state)
}

fn singverse_url(state: &AppState, path: &str) -> String {
    state
        .singverse
        .as_ref()
        .map(|sv| format!("{}{path}", sv.config.url))
        .unwrap_or_else(|| "/".to_string())
}

#[derive(Deserialize)]
struct EnterQuery {
    token: Option<String>,
}

/// `/room/{uuid}?token=…` from SingVerse: swap the token for a session cookie
/// and drop it from the address bar. Without a token, the screen loads only
/// for a session of this room; anyone else goes back to the room on SingVerse.
async fn enter(
    State(state): State<AppState>,
    AxumPath(room): AxumPath<String>,
    Query(query): Query<EnterQuery>,
    headers: HeaderMap,
) -> Response {
    let Some(singverse) = state.singverse.as_ref() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !auth::is_uuid(&room) {
        return StatusCode::NOT_FOUND.into_response();
    }

    if let Some(token) = query.token {
        return match auth::verify_jwt(&singverse.config.secret, &token, &room) {
            Ok(claims) => {
                tracing::info!(room, host = %claims.sub, name = %claims.name, "screen opened");
                let expires = auth::now() + auth::SESSION_SECS;
                let Ok(value) =
                    auth::session_cookie_value(&singverse.config.secret, &room, expires)
                else {
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                };
                let mut response = Redirect::to(&format!("/room/{room}")).into_response();
                if let Some(cookie) =
                    auth::set_cookie_header(&value, singverse.config.secure_cookies)
                {
                    response.headers_mut().insert(header::SET_COOKIE, cookie);
                }
                response
            }
            Err(error) => {
                tracing::warn!(room, "rejected screen token: {error}");
                Redirect::to(&singverse_url(&state, &format!("/karaoke/{room}"))).into_response()
            }
        };
    }

    match auth::session_from_headers(&singverse.config.secret, &headers) {
        Some(session) if session.room == room => static_files::serve_index(),
        _ => Redirect::to(&singverse_url(&state, &format!("/karaoke/{room}"))).into_response(),
    }
}

/// Built assets are public (the app shell is useless without a session);
/// every other page belongs to SingVerse.
async fn fallback(State(state): State<AppState>, uri: Uri) -> Response {
    if let Some(asset) = static_files::serve_path(&uri) {
        return asset;
    }
    Redirect::to(&singverse_url(&state, "/karaoke")).into_response()
}

/// A refusal when the session belongs to another room.
fn other_room(session: &Session, room: &str) -> Option<Response> {
    (session.room != room)
        .then(|| (StatusCode::FORBIDDEN, "this screen belongs to another room").into_response())
}

fn api_error(error: ApiError) -> Response {
    match error {
        ApiError::Status(status, message) => (
            StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
            message,
        )
            .into_response(),
        ApiError::Transport(message) => (StatusCode::BAD_GATEWAY, message).into_response(),
    }
}

async fn room_state(
    State(state): State<AppState>,
    Extension(session): Extension<Session>,
    AxumPath(room): AxumPath<String>,
) -> Response {
    if let Some(response) = other_room(&session, &room) {
        return response;
    }
    let Some(singverse) = state.singverse.as_ref() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match rooms::state(singverse, &room).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => api_error(error),
    }
}

#[derive(Deserialize)]
struct StartBody {
    item: String,
}

async fn room_start(
    State(state): State<AppState>,
    Extension(session): Extension<Session>,
    AxumPath(room): AxumPath<String>,
    Json(body): Json<StartBody>,
) -> Response {
    if let Some(response) = other_room(&session, &room) {
        return response;
    }
    let Some(singverse) = state.singverse.clone() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !auth::is_uuid(&body.item) {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }

    let client = singverse.client.clone();
    let (room_id, item) = (room.clone(), body.item);
    match tokio::task::spawn_blocking(move || client.start(&room_id, &item)).await {
        Ok(Ok(fresh)) => {
            singverse.rooms.store(&room, fresh.clone());
            Json(rooms::with_preparation(&singverse, fresh)).into_response()
        }
        Ok(Err(error)) => api_error(error),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct FinishBody {
    item: String,
    #[serde(default)]
    score: Option<u32>,
    #[serde(default)]
    skipped: bool,
}

/// The song ended on this screen: SingVerse saves the score on the singer's
/// profile (Nightingale's own `profiles.json` is not used in rooms).
async fn room_finish(
    State(state): State<AppState>,
    Extension(session): Extension<Session>,
    AxumPath(room): AxumPath<String>,
    Json(body): Json<FinishBody>,
) -> Response {
    if let Some(response) = other_room(&session, &room) {
        return response;
    }
    let Some(singverse) = state.singverse.clone() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !auth::is_uuid(&body.item) {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }

    let client = singverse.client.clone();
    let room_id = room.clone();
    let score = body.score.map(|s| s.min(1000));
    let result = tokio::task::spawn_blocking(move || {
        client.finish(&room_id, &body.item, score, body.skipped)
    })
    .await;

    match result {
        Ok(Ok(mut fresh)) => {
            let performance = fresh.as_object_mut().and_then(|o| o.remove("performance"));
            singverse.rooms.store(&room, fresh.clone());
            let mut answer = rooms::with_preparation(&singverse, fresh);
            if let (Some(object), Some(performance)) = (answer.as_object_mut(), performance) {
                object.insert("performance".into(), performance);
            }
            Json(answer).into_response()
        }
        Ok(Err(error)) => api_error(error),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    }
}

/// Keeps the operator's storage and analyzer settings whatever the screen sends.
pub(crate) fn sanitize_command(name: &str, mut payload: Value) -> Result<Value, &'static str> {
    if !ROOM_COMMANDS.contains(&name) {
        return Err("command is not available on karaoke room screens");
    }

    if name == "save_config" {
        let current = serde_json::to_value(app_core::AppConfig::load()).unwrap_or(Value::Null);
        if let Some(config) = payload.get_mut("config").and_then(Value::as_object_mut) {
            for key in PINNED_CONFIG {
                match current.get(*key) {
                    Some(value) => config.insert((*key).to_string(), value.clone()),
                    None => config.remove(*key),
                };
            }
        }
    }

    Ok(payload)
}

async fn room_cmd(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
    body: Option<Json<Value>>,
) -> Response {
    let payload = body.map(|Json(value)| value).unwrap_or(Value::Null);
    let payload = match sanitize_command(&name, payload) {
        Ok(payload) => payload,
        Err(reason) => return (StatusCode::FORBIDDEN, reason).into_response(),
    };

    match app_api::dispatch(state.commands.clone(), &name, payload).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => CommandApiError::from(error).into_response(),
    }
}

fn allowed_asset(path: &str) -> bool {
    if path.starts_with("nge://") {
        return true;
    }
    let file = Path::new(path);
    if app_core::media_server::is_cover_art_path(file) {
        return true;
    }
    file.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ASSET_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

async fn room_asset(
    state: State<AppState>,
    Query(query): Query<AssetQuery>,
    headers: HeaderMap,
    request: Request<Body>,
) -> Response {
    if query.download || !allowed_asset(&query.path) {
        return (StatusCode::NOT_FOUND, "media path not found").into_response();
    }
    media::handle_asset(state, Query(query), headers, request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_playback_commands_pass() {
        assert!(sanitize_command("load_transcript", Value::Null).is_ok());
        for blocked in [
            "trigger_scan",
            "set_library_source",
            "add_score",
            "create_profile",
            "trigger_setup",
            "reanalyze_full",
            "add_playback_queue_entry",
        ] {
            assert!(
                sanitize_command(blocked, Value::Null).is_err(),
                "{blocked} must be blocked"
            );
        }
    }

    #[test]
    fn assets_are_limited_to_media() {
        assert!(allowed_asset("nge://abcd/instrumental.mp3"));
        assert!(allowed_asset("/data/videos/clip.MP4"));
        assert!(!allowed_asset("/data/config.json"));
        assert!(!allowed_asset("/data/songs.db"));
        assert!(!allowed_asset("/data/secret"));
    }
}
