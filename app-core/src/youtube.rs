//! YouTube Data API v3 search for the song-list fallback.
//!
//! The Nightingale desktop library only searches songs that have been
//! imported into the local SQLite `songs.db`. Sometimes the operator
//! wants a song that's nowhere in the library yet — a request from a
//! guest, a song only on a USB stick, etc. The frontend renders a
//! checkbox in the search toolbar; when it's ticked, the query (plus
//! " karaoke") hits YouTube Data API v3 and the top 5 hits render under
//! a "From YouTube" separator in the same list. Clicking a row opens
//! the video in the user's default browser — no download, no library
//! import, no scoring. See `client/src/features/library/hooks/use-youtube-search.ts`
//! and the Tauri command in `client/src-tauri/src/playback.rs` for the
//! matching JS/TS layers.
//!
//! Reference: <https://developers.google.com/youtube/v3/docs/search/list>.

use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use ureq::tls::{RootCerts, TlsConfig, TlsProvider};

use crate::playback::urlencode_query;

const YOUTUBE_API_BASE: &str = "https://www.googleapis.com/youtube/v3/search";

/// Single shared HTTP agent for YouTube Data API requests.
///
/// `TlsProvider::NativeTls` is *not* picked up automatically by
/// `ureq::get` — the default agent hardcodes `TlsProvider::Rustls`,
/// which on Windows ships only Mozilla's bundled CA roots and rejects
/// hosts behind a corporate MITM (e.g. Avast Web Shield). Building the
/// agent explicitly with `RootCerts::PlatformVerifier` delegates chain
/// validation to native-tls (schannel on Windows), which trusts the
/// Windows cert store and therefore the local Avast root.
static YOUTUBE_AGENT: LazyLock<ureq::Agent> = LazyLock::new(|| {
    use ureq::config::Config;
    Config::builder()
        .tls_config(
            TlsConfig::builder()
                .provider(TlsProvider::NativeTls)
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .build()
        .into()
});

/// One item in the search result. Fields are kept narrow on purpose:
/// the UX only needs enough to render a card and link out. Anything
/// beyond that (channel id, publish date, view count) bloats the JSON
/// and is currently unused by the frontend.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct YouTubeHit {
    pub video_id: String,
    pub title: String,
    pub channel_title: String,
    pub thumbnail_url: String,
    /// Canonical watch URL, `https://www.youtube.com/watch?v=<video_id>`.
    /// The frontend opens this in the user's default browser via
    /// `tauri-plugin-opener` on desktop or `window.open` on `/guest`.
    pub watch_url: String,
}

#[derive(Debug, Deserialize)]
struct ApiResponse {
    items: Vec<ApiItem>,
}

#[derive(Debug, Deserialize)]
struct ApiItem {
    id: ApiItemId,
    snippet: ApiSnippet,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiItemId {
    video_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiSnippet {
    title: String,
    /// `channelTitle` is present on `youtube#video` items but absent on
    /// `youtube#channel` items. We ask the API for `type=video`, but
    /// the search endpoint occasionally returns a channel row anyway
    /// when the query matches a channel name verbatim — leaving this
    /// required would crash deserialization with a confusing
    /// "missing field `channel_title`" error. Defaulted to empty.
    #[serde(default)]
    channel_title: String,
    thumbnails: ApiThumbnails,
}

#[derive(Debug, Deserialize)]
struct ApiThumbnails {
    /// `medium` is the default — 320×180, sharp on retina without
    /// ballooning the JSON payload. The frontend resolves to
    /// `high` → `medium` → `default` on this side so missing sizes
    /// degrade gracefully.
    #[serde(default)]
    medium: Option<ApiThumb>,
    #[serde(default)]
    high: Option<ApiThumb>,
    #[serde(default)]
    default: Option<ApiThumb>,
}

#[derive(Debug, Deserialize)]
struct ApiThumb {
    url: String,
}

/// Hit YouTube Data API v3 `search.list` with
/// `type=video&videoCategoryId=10` (Music) and `maxResults=5` by
/// default. The `query_with_karaoke` parameter is assumed to already
/// have `" karaoke"` appended by the caller — keeping the karaoke
/// suffix out of this layer lets a future "videos (no karaoke)" mode
/// slot in without forking this function.
///
/// Errors are returned as plain `String` so the Tauri / axum
/// dispatch layers can surface them verbatim via toast without
/// additional unwrapping. The most common flavours are 401 (bad key),
/// 403 (quota exceeded), and 429 (rate limited) — all of which
/// `map_ureq_error` lifts into a single readable line.
pub fn search_youtube(
    api_key: &str,
    query_with_karaoke: &str,
    max_results: u8,
) -> Result<Vec<YouTubeHit>, String> {
    if api_key.trim().is_empty() {
        return Err("YouTube API key is not configured. Add it in Settings → Library.".into());
    }
    if query_with_karaoke.trim().is_empty() {
        return Err("search query is empty".into());
    }

    let url = format!(
        "{YOUTUBE_API_BASE}?part=snippet&type=video&videoCategoryId=10&q={q}&maxResults={n}&key={k}",
        q = urlencode_query(query_with_karaoke),
        n = max_results,
        k = urlencode_query(api_key),
    );

    let body: ApiResponse = YOUTUBE_AGENT
        .get(&url)
        .call()
        .map_err(|error| format!("YouTube request failed: {error}"))?
        .body_mut()
        .read_json()
        .map_err(|error| format!("Failed to parse YouTube response: {error}"))?;

    let hits = body
        .items
        .into_iter()
        .filter_map(|item| {
            let video_id = item.id.video_id?;
            let thumb = item
                .snippet
                .thumbnails
                .high
                .or(item.snippet.thumbnails.medium)
                .or(item.snippet.thumbnails.default)?;
            Some(YouTubeHit {
                watch_url: format!("https://www.youtube.com/watch?v={video_id}"),
                thumbnail_url: thumb.url,
                channel_title: item.snippet.channel_title,
                title: item.snippet.title,
                video_id,
            })
        })
        .collect();

    Ok(hits)
}
