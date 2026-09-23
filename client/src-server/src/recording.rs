//! HTTP handler that streams a single recording's WAV blob back to the
//! client. Lives next to `media.rs` for symmetry, but a separate module
//! because the path-keyed route there would happily canonicalise any
//! absolute path inside the data dir — recordings are reached by a
//! short id, not a hash, and we want a strict 404 on anything else.

use axum::{
    body::Body,
    extract::{Path as AxumPath, State},
    http::header::HeaderValue,
    http::{HeaderMap, StatusCode},
    response::Response,
};
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::state::AppState;

pub(crate) async fn handle_recording(
    State(_state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    _headers: HeaderMap,
    request: axum::http::Request<Body>,
) -> Response<Body> {
    // Sanitise the id before looking it up. RecordingStore assigns ids
    // via `fetch_add`, so they're always positive integers — but a
    // hostile client might send `..` or `/`. Allow `[A-Za-z0-9_-]` and
    // reject everything else so the canonicalise step never sees a
    // path-traversal vector.
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return not_found("invalid recording id");
    }

    let Some(path) = app_core::RecordingStore::wav_path_for(&id) else {
        return not_found("recording not found");
    };

    // Defence-in-depth: even though RecordingStore::wav_path only
    // resolves into the recordings folder, double-check the resolved
    // path stays under the data dir.
    if !app_core::is_within_recordings(&path) {
        return not_found("recording path outside data dir");
    }

    let serve = ServeFile::new(&path);
    match serve.oneshot(request).await {
        Ok(response) => annotate_audio(response.map(Body::new)),
        Err(e) => {
            tracing::warn!("recording serve error: {e}");
            response(
                StatusCode::INTERNAL_SERVER_ERROR,
                Body::from("failed to serve recording"),
            )
        }
    }
}

fn annotate_audio(mut response: Response<Body>) -> Response<Body> {
    let headers = response.headers_mut();
    headers
        .entry(axum::http::header::CACHE_CONTROL)
        .or_insert_with(|| HeaderValue::from_static("private, max-age=300"));
    headers
        .entry(axum::http::header::X_CONTENT_TYPE_OPTIONS)
        .or_insert_with(|| HeaderValue::from_static("nosniff"));
    response
}

fn response(status: StatusCode, body: Body) -> Response<Body> {
    let mut response = Response::new(body);
    *response.status_mut() = status;
    response
}

fn not_found(reason: &str) -> Response<Body> {
    response(StatusCode::NOT_FOUND, Body::from(reason.to_string()))
}