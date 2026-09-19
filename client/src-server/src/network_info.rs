use axum::{extract::State, Json};
use serde::Serialize;

use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NetworkInfo {
    /// IPv4 addresses on the host machine that phones on the LAN can reach.
    /// Empty when the operator hasn't run the guest QR generator yet.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    lan_ips: Vec<String>,
    /// Port the HTTP/WS listener is bound on.
    port: u16,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NetworkInfoFile {
    #[serde(default)]
    lan_ips: Vec<String>,
    #[serde(default = "default_port")]
    port: u16,
}

fn default_port() -> u16 {
    8080
}

/// Returns the host's reachable LAN IPv4 addresses (and the bound port) so
/// the SPA can render a guest QR that points to a URL phones can actually
/// reach, regardless of where the host happens to be browsing from.
///
/// Reads `network-info.json` from the data folder. The file is written by
/// `scripts/print_guest_qr.py` on startup; when it's missing or stale the
/// endpoint falls back to an empty `lanIps` so the SPA can show a hint.
pub(crate) async fn handle(State(_state): State<AppState>) -> Json<NetworkInfo> {
    let path = app_core::nightingale_dir().join("network-info.json");
    let info = read_info(&path).unwrap_or_else(|| NetworkInfoFile {
        lan_ips: Vec::new(),
        port: default_port(),
    });

    Json(NetworkInfo {
        lan_ips: info.lan_ips,
        port: info.port,
    })
}

fn read_info(path: &std::path::Path) -> Option<NetworkInfoFile> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}
