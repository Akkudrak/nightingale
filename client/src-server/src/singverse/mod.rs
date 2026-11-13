//! SingVerse mode: this server becomes the screen of SingVerse karaoke rooms.
//!
//! SingVerse (a Laravel site) owns accounts, the song catalogue, rooms and
//! their queues; phones queue songs there. The room's host opens this server
//! through a short-lived signed link, and the screen:
//!
//! 1. polls the room's queue from SingVerse's signed server API,
//! 2. downloads each queued song's pre-analyzed `.nge` into the pinned folder
//!    library (no analyzer, no GPU),
//! 3. plays it with Nightingale's own playback screen and pitch scoring,
//! 4. reports start, end and the singer's score back to SingVerse, which saves
//!    it on the singer's profile.
//!
//! Everything else this server can do (library management, sources, the
//! analyzer, profiles, the LAN phone remote) is closed in this mode.

mod auth;
mod client;
mod fetch;
mod http;
mod mega;
mod rooms;

use std::path::PathBuf;
use std::sync::Arc;

pub(crate) use http::router;

use client::SingVerseClient;
use fetch::Downloader;
use rooms::RoomStore;

/// Operator settings, read from the environment.
#[derive(Clone, Debug)]
pub struct SingVerseConfig {
    /// SingVerse's base URL, e.g. `https://singverse.example`.
    pub url: String,
    /// Shared with SingVerse's `NIGHTINGALE_SECRET`: verifies the host's entry
    /// link and signs every API call.
    pub secret: Vec<u8>,
    /// Pinned folder library where downloaded bundles live.
    pub library: PathBuf,
    /// Size cap for downloaded bundles; the least recently played go first.
    pub cache_bytes: u64,
    /// `Secure` session cookies. Only switch off for plain-HTTP local testing.
    pub secure_cookies: bool,
}

impl SingVerseConfig {
    /// `Ok(None)` when `SINGVERSE_URL` is unset: plain Nightingale.
    pub fn from_env(library: Option<&str>) -> Result<Option<Self>, String> {
        let url = std::env::var("SINGVERSE_URL").unwrap_or_default();
        let url = url.trim().trim_end_matches('/').to_string();
        if url.is_empty() {
            return Ok(None);
        }
        if !url.starts_with("https://") && !url.starts_with("http://") {
            return Err("SINGVERSE_URL must start with http:// or https://".into());
        }

        let secret = std::env::var("SINGVERSE_SECRET").unwrap_or_default();
        if secret.trim().len() < 32 {
            return Err("SINGVERSE_SECRET must be at least 32 characters".into());
        }

        let Some(library) = library else {
            return Err(
                "SingVerse mode needs NIGHTINGALE_LIBRARY_PATH (the download folder)".into(),
            );
        };

        let cache_mb = std::env::var("SINGVERSE_CACHE_MB")
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
            .unwrap_or(4096);

        let secure_cookies = !matches!(
            std::env::var("SINGVERSE_INSECURE_COOKIES").as_deref(),
            Ok("1" | "true" | "yes")
        );

        Ok(Some(Self {
            url,
            secret: secret.trim().as_bytes().to_vec(),
            library: PathBuf::from(library),
            cache_bytes: cache_mb.saturating_mul(1024 * 1024),
            secure_cookies,
        }))
    }
}

/// Shared SingVerse-mode services, hung off [`crate::AppState`].
pub struct SingVerse {
    pub(crate) config: SingVerseConfig,
    pub(crate) client: SingVerseClient,
    pub(crate) downloads: Arc<Downloader>,
    pub(crate) rooms: RoomStore,
}

impl SingVerse {
    pub fn new(config: SingVerseConfig) -> Result<Self, String> {
        std::fs::create_dir_all(&config.library)
            .map_err(|e| format!("cannot create {}: {e}", config.library.display()))?;

        Ok(Self {
            client: SingVerseClient::new(config.url.clone(), config.secret.clone()),
            downloads: Arc::new(Downloader::new(config.library.clone(), config.cache_bytes)),
            rooms: RoomStore::default(),
            config,
        })
    }
}
