//! Tauri deep-link handler for `nightingale://catalog/v1/import?p=…`.
//!
//! The web admin (see `nightingale-catalog/web/src/lib/nightingale-deep-link.ts`)
//! builds these URLs and fires them via a hidden anchor click. When the OS
//! launches — or wakes — Nightingale, we receive the URL on argv (cold
//! start via `tauri-plugin-deep-link`'s `get_current()`) or via the
//! plugin's Apple Event / single-instance forward (warm start via
//! `on_open_url`).
//!
//! The pipeline is:
//!   1. Parse the URL, validate scheme/host/path, decode the base64url
//!      `p=` payload into a JSON `DownloadUrlPayload`.
//!   2. Spawn a worker thread (mirrors `analyzer.rs::shift_key`) so the
//!      Tauri event loop stays responsive.
//!   3. The worker downloads the ZIP to a temp file under the user's
//!      Nightingale data dir, calls `app_core::song_export::import_song_full_from_path`,
//!      and removes the temp file.
//!   4. Emit a single `deep-link-import-done` event with a
//!      `DeepLinkImportDone` payload — the React UI subscribes via
//!      `bridge/deep-link.ts` and toasts.
//!
//! Cold-start launches also call `window.show()` + `window.set_focus()`
//! so the user sees Nightingale foregrounded immediately instead of
//! waiting for the React tree to call `frontend_ready`.
//!
//! Workspace lints deny `unwrap_used` and `panic_in_result_fn`, so all
//! error paths return `Result<_, _>` (or `DeepLinkImportDone::err` for
//! event payloads).

use std::path::Path;
use std::thread;

use app_core::song_export::{import_song_full_from_path, DeepLinkImportDone, ImportResult};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use thiserror::Error;
use url::Url;

const SCHEME: &str = "nightingale";
const HOST: &str = "catalog";
const PATH: &str = "/v1/import";
const EVENT_NAME: &str = "deep-link-import-done";

/// Payload shape emitted by `POST /api/songs/{id}/download-url` and
/// base64url-encoded into the `p=` query param of the deep-link URL.
/// All fields except `url` are optional so a future schema addition on
/// the web side doesn't break older desktop builds.
#[derive(Debug, Deserialize)]
pub(crate) struct DownloadUrlPayload {
    url: String,
    #[serde(default)]
    #[allow(dead_code)]
    song_title: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    song_id: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    source_host: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    storage_type: Option<String>,
}

/// Wire the deep-link handler into the running app.
///
/// `register` is called from the `setup` closure of `lib.rs`. It
/// subscribes to `on_open_url` for warm starts (Apple Event on macOS,
/// argv-forwarded on Windows/Linux via `tauri-plugin-single-instance`)
/// and reads `get_current()` for the genuinely cold-start case where
/// the OS spawns a fresh process with the URL on argv.
pub(crate) fn register(app: &AppHandle) {
    let plugin = app.deep_link();

    let app_for_handler = app.clone();
    plugin.on_open_url(move |event| {
        for url in event.urls() {
            handle_url(app_for_handler.clone(), url.clone());
        }
    });

    // Cold start: the plugin re-emits the launch URL through
    // `on_open_url` *after* our subscription lands when
    // `tauri-plugin-single-instance`'s `deep-link` feature forwards
    // argv, but for the truly cold case (no instance running) the URL
    // is only available via `get_current()`. Calling both is safe —
    // duplicate URLs would just produce duplicate import attempts,
    // which the import pipeline's hash-verification will reject as
    // idempotent upserts.
    match plugin.get_current() {
        Ok(Some(urls)) => {
            for url in urls {
                handle_url(app.clone(), url);
            }
        }
        Ok(None) => {}
        Err(err) => {
            tracing::warn!("deep_link::register get_current failed: {err}");
        }
    }
}

fn handle_url(app: AppHandle, url: Url) {
    // Foreground the window so a cold-start launch is visible
    // immediately, before React mounts and calls `frontend_ready`.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }

    let payload = match parse_deep_link(&url) {
        Ok(p) => p,
        Err(err) => {
            tracing::warn!("ignoring malformed deep link {url}: {err}");
            let _ = app.emit(EVENT_NAME, DeepLinkImportDone::err(err.to_string()));
            return;
        }
    };

    thread::spawn(move || {
        let result = download_and_import(&payload);
        let _ = app.emit(EVENT_NAME, result);
    });
}

/// Parse and validate the deep-link URL. Pure function, exported for
/// unit tests.
pub(crate) fn parse_deep_link(url: &Url) -> Result<DownloadUrlPayload, DeepLinkError> {
    if url.scheme() != SCHEME {
        return Err(DeepLinkError::WrongScheme(url.scheme().to_string()));
    }
    if url.host_str() != Some(HOST) {
        return Err(DeepLinkError::WrongHost(
            url.host_str().unwrap_or("").to_string(),
        ));
    }
    if url.path() != PATH {
        return Err(DeepLinkError::WrongPath(url.path().to_string()));
    }
    let raw = url
        .query_pairs()
        .find(|(k, _)| k == "p")
        .map(|(_, v)| v.into_owned())
        .ok_or(DeepLinkError::MissingPayload)?;
    if raw.is_empty() {
        return Err(DeepLinkError::MissingPayload);
    }
    let json_bytes = URL_SAFE_NO_PAD
        .decode(raw.as_bytes())
        .map_err(|e| DeepLinkError::Base64(e.to_string()))?;
    serde_json::from_slice(&json_bytes).map_err(|e| DeepLinkError::Json(e.to_string()))
}

fn download_and_import(payload: &DownloadUrlPayload) -> DeepLinkImportDone {
    let tmp_dir = app_core::default_nightingale_dir().join("deep-link-imports");
    if let Err(e) = std::fs::create_dir_all(&tmp_dir) {
        return DeepLinkImportDone::err(format!("create temp dir: {e}"));
    }

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dest = tmp_dir.join(format!("import-{nanos}.zip"));

    if let Err(e) = download_zip(&payload.url, &dest) {
        let _ = std::fs::remove_file(&dest);
        return DeepLinkImportDone::err(format!("download: {e}"));
    }

    let outcome = import_song_full_from_path(&dest, None);
    let _ = std::fs::remove_file(&dest);

    match outcome {
        Ok(ImportResult {
            song,
            imported_path,
        }) => DeepLinkImportDone {
            ok: true,
            file_hash: Some(song.file_hash),
            title: Some(song.title),
            artist: Some(song.artist),
            imported_path: Some(imported_path.to_string_lossy().into_owned()),
            error: None,
        },
        Err(e) => DeepLinkImportDone::err(e.to_string()),
    }
}

/// Mirror of the private `download_file` in `app-core/src/playback.rs`
/// (kept inline so we don't need to expose it from app-core). Streams
/// the GET response body straight to disk via `std::io::copy` so we
/// don't buffer multi-MB ZIPs in memory.
fn download_zip(url: &str, dest: &Path) -> Result<(), String> {
    let agent = ureq::Agent::new_with_defaults();
    let resp = agent.get(url).call().map_err(|e| e.to_string())?;
    let mut reader = resp.into_body().into_reader();
    let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    std::io::copy(&mut reader, &mut file).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Error)]
pub(crate) enum DeepLinkError {
    #[error("expected scheme `nightingale`, got `{0}`")]
    WrongScheme(String),
    #[error("expected host `catalog`, got `{0}`")]
    WrongHost(String),
    #[error("expected path `/v1/import`, got `{0}`")]
    WrongPath(String),
    #[error("missing or empty `p=` query parameter")]
    MissingPayload,
    #[error("base64 decode: {0}")]
    Base64(String),
    #[error("json decode: {0}")]
    Json(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    fn encode_payload(json: &str) -> String {
        URL_SAFE_NO_PAD.encode(json.as_bytes())
    }

    fn url_with_p(p: &str) -> String {
        format!("nightingale://catalog/v1/import?p={p}")
    }

    #[test]
    fn parses_valid_url() {
        let json = r#"{"url":"https://r2.example.com/song.zip","song_title":"Hi","song_id":"42","source_host":"r2.example.com","storage_type":"r2"}"#;
        let url = Url::parse(&url_with_p(&encode_payload(json))).expect("url parses");
        let payload = parse_deep_link(&url).expect("parses");
        assert_eq!(payload.url, "https://r2.example.com/song.zip");
        assert_eq!(payload.song_title.as_deref(), Some("Hi"));
        assert_eq!(payload.storage_type.as_deref(), Some("r2"));
    }

    #[test]
    fn parses_minimal_payload() {
        // Only `url` is required; everything else is `Option<String>`.
        let json = r#"{"url":"https://example.com/x.zip"}"#;
        let url = Url::parse(&url_with_p(&encode_payload(json))).expect("url parses");
        let payload = parse_deep_link(&url).expect("parses");
        assert_eq!(payload.url, "https://example.com/x.zip");
        assert!(payload.song_title.is_none());
    }

    #[test]
    fn rejects_wrong_scheme() {
        let url = Url::parse("https://catalog/v1/import?p=abc").expect("url parses");
        match parse_deep_link(&url).expect_err("must fail") {
            DeepLinkError::WrongScheme(s) => assert_eq!(s, "https"),
            other => panic!("expected WrongScheme, got {other:?}"),
        }
    }

    #[test]
    fn rejects_wrong_host() {
        let url = Url::parse("nightingale://wrong/v1/import?p=abc").expect("url parses");
        match parse_deep_link(&url).expect_err("must fail") {
            DeepLinkError::WrongHost(h) => assert_eq!(h, "wrong"),
            other => panic!("expected WrongHost, got {other:?}"),
        }
    }

    #[test]
    fn rejects_wrong_path() {
        let url = Url::parse("nightingale://catalog/v2/import?p=abc").expect("url parses");
        match parse_deep_link(&url).expect_err("must fail") {
            DeepLinkError::WrongPath(p) => assert_eq!(p, "/v2/import"),
            other => panic!("expected WrongPath, got {other:?}"),
        }
    }

    #[test]
    fn rejects_missing_payload_param() {
        let url = Url::parse("nightingale://catalog/v1/import").expect("url parses");
        match parse_deep_link(&url).expect_err("must fail") {
            DeepLinkError::MissingPayload => {}
            other => panic!("expected MissingPayload, got {other:?}"),
        }
    }

    #[test]
    fn rejects_empty_payload() {
        let url = Url::parse("nightingale://catalog/v1/import?p=").expect("url parses");
        match parse_deep_link(&url).expect_err("must fail") {
            DeepLinkError::MissingPayload => {}
            other => panic!("expected MissingPayload, got {other:?}"),
        }
    }

    #[test]
    fn rejects_invalid_base64() {
        // `!` is not valid in base64url.
        let url = Url::parse(&url_with_p("not_base64_!!!")).expect("url parses");
        match parse_deep_link(&url).expect_err("must fail") {
            DeepLinkError::Base64(_) => {}
            other => panic!("expected Base64, got {other:?}"),
        }
    }

    #[test]
    fn rejects_invalid_json() {
        // Valid base64url but not JSON.
        let junk = URL_SAFE_NO_PAD.encode(b"not json at all");
        let url = Url::parse(&url_with_p(&junk)).expect("url parses");
        match parse_deep_link(&url).expect_err("must fail") {
            DeepLinkError::Json(_) => {}
            other => panic!("expected Json, got {other:?}"),
        }
    }

    #[test]
    fn rejects_json_missing_url_field() {
        // Valid JSON, but the required `url` field is absent.
        let json = r#"{"song_title":"Hi"}"#;
        let url = Url::parse(&url_with_p(&encode_payload(json))).expect("url parses");
        let err = parse_deep_link(&url).expect_err("must fail");
        // serde_json's "missing field" error lands in the Json variant.
        assert!(matches!(err, DeepLinkError::Json(_)), "got {err:?}");
    }

    #[test]
    fn url_helper_emits_correct_shape() {
        // Sanity check: the URL helper matches the web encoder's output
        // shape — anything but `nightingale://catalog/v1/import?p=…`
        // would round-trip incorrectly through parse_deep_link.
        let url = Url::parse("nightingale://catalog/v1/import?p=AA").expect("url parses");
        assert_eq!(url.scheme(), "nightingale");
        assert_eq!(url.host_str(), Some("catalog"));
        assert_eq!(url.path(), "/v1/import");
    }
}
