//! `nightingale-import://` deep-link handler.
//!
//! Mirrors `client/src-tauri/src/deep_link.rs` but for the dedicated
//! importer scheme. The URL format is identical:
//!
//! ```text
//! nightingale-import://catalog/v1/import?p=<base64url(JSON)>
//! ```
//!
//! where the JSON is a `DownloadUrlPayload` with the same shape the
//! main app accepts (`{ url, song_title?, song_id?, source_host?, storage_type? }`).
//!
//! The worker thread downloads the ZIP to a temp file under the
//! user's chosen `system_folder`, calls
//! `app_core::catalog_import::import_catalog_zip`, deletes the temp
//! file, and emits a single `deep-link-import-done` event the React
//! UI listens for.

use std::path::Path;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use app_core::{
    catalog_import::{import_catalog_zip, CatalogImportDone},
    default_config_path, load_importer_config,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use thiserror::Error;
use url::Url;

const SCHEME: &str = "nightingale-import";
const HOST: &str = "catalog";
const PATH: &str = "/v1/import";
const EVENT_NAME: &str = "deep-link-import-done";

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
    source_host: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    storage_type: Option<String>,
}

/// Wire the deep-link plugin into the running app. Called from
/// `lib.rs::run`'s `setup` closure. Subscribes to `on_open_url` for
/// warm starts and reads `get_current()` for cold starts (the OS
/// spawns a fresh process with the URL on argv in that case).
pub(crate) fn register(app: &AppHandle) {
    let plugin = app.deep_link();

    let app_for_handler = app.clone();
    plugin.on_open_url(move |event| {
        for url in event.urls() {
            handle_url(app_for_handler.clone(), url.clone());
        }
    });

    match plugin.get_current() {
        Ok(Some(urls)) => {
            for url in urls {
                handle_url(app.clone(), url);
            }
        }
        Ok(None) => {}
        Err(err) => {
            tracing::warn!(target: "importer.deep_link", "deep_link::register get_current failed: {err}");
        }
    }
}

fn handle_url(app: AppHandle, url: Url) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }

    let payload = match parse_deep_link(&url) {
        Ok(p) => p,
        Err(err) => {
            tracing::warn!(target: "importer.deep_link", "ignoring malformed deep link {url}: {err}");
            let _ = app.emit(EVENT_NAME, CatalogImportDone::err(err.to_string()));
            return;
        }
    };

    thread::spawn(move || {
        let outcome = process(&app, &payload);
        let _ = app.emit(EVENT_NAME, outcome);
    });
}

fn process(_app: &AppHandle, payload: &DownloadUrlPayload) -> CatalogImportDone {
    let host = payload.source_host.as_deref().unwrap_or("<unknown>");
    tracing::info!(
        target: "importer.download",
        "deep link received; source_host={host}; downloading zip"
    );

    let cfg = match load_importer_config(&default_config_path()) {
        Ok(c) => c,
        Err(e) => {
            return CatalogImportDone::err(format!(
                "importer is not configured ({e}); run the wizard first"
            ));
        }
    };

    let tmp_dir = cfg.system_folder.join("deep-link-imports");
    if let Err(e) = std::fs::create_dir_all(&tmp_dir) {
        return CatalogImportDone::err(format!("create temp dir: {e}"));
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let zip_path = tmp_dir.join(format!("import-{nanos}.zip"));

    if let Err(e) = download_zip(&payload.url, &zip_path) {
        let _ = std::fs::remove_file(&zip_path);
        return CatalogImportDone::err(format!("download: {e}"));
    }

    let zip_bytes = match std::fs::read(&zip_path) {
        Ok(b) => b,
        Err(e) => {
            let _ = std::fs::remove_file(&zip_path);
            return CatalogImportDone::err(format!("read temp zip: {e}"));
        }
    };
    let _ = std::fs::remove_file(&zip_path);

    match import_catalog_zip(
        &zip_bytes,
        &cfg.system_folder,
        &cfg.library_folder,
        &cfg.allowed_cover_hosts,
    ) {
        Ok(done) => done,
        Err(e) => CatalogImportDone::err(e.to_string()),
    }
}

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
    #[error("expected scheme `{SCHEME}`, got `{0}`")]
    WrongScheme(String),
    #[error("expected host `{HOST}`, got `{0}`")]
    WrongHost(String),
    #[error("expected path `{PATH}`, got `{0}`")]
    WrongPath(String),
    #[error("missing or empty `p=` query parameter")]
    MissingPayload,
    #[error("base64 decode: {0}")]
    Base64(String),
    #[error("json decode: {0}")]
    Json(String),
}
