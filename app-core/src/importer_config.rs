//! Owns the standalone catalog importer's on-disk config.
//!
//! The catalog importer ([`crate::catalog_import`]) is a separate Tauri
//! shell installed alongside Nightingale 1.0.0+ to receive catalog-song
//! imports on installs that don't ship the in-app deep-link receiver.
//! Its config is therefore deliberately separate from the main
//! `~/.nightingale/config.json` (which the importer never reads or
//! writes) so the two settings never drift.
//!
//! Layout: `%APPDATA%/com.rzru.catalog-importer/config.json` (Roaming
//! AppData on Windows; the bundle identifier is configured in
//! `client-catalog-importer/src-tauri/tauri.conf.json`).
//!
//! ## Trust boundary
//!
//! `allowed_cover_hosts` gates every outbound HTTPS request that
//! [`crate::catalog_import`] makes for `metadata.json.cover_url`. The
//! list is editable by the user via the importer UI; the default
//! values are deliberately permissive placeholders for the catalog
//! team's own hosts (signed R2 URLs etc.). Edit at your own peril.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

const BUNDLE_ID: &str = "com.rzru.catalog-importer";
const CONFIG_FILE: &str = "config.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImporterConfig {
    /// Parent directory of the user's `songs.db`, `cache/`, and `vendor/`.
    /// On a default Nightingale install this resolves to
    /// `C:\Users\<user>\.nightingale` (NOT `\.Music`).
    pub system_folder: PathBuf,
    /// Folder the importer drops `.mp3` files into. Usually the user's
    /// `Music` folder.
    pub library_folder: PathBuf,
    /// Allowlist of hosts the importer will fetch catalog cover art from.
    /// Supports exact host matches and single-segment wildcards (`pub-*.r2.dev`).
    #[serde(default)]
    pub allowed_cover_hosts: Vec<String>,
}

impl ImporterConfig {
    pub fn new(system_folder: PathBuf, library_folder: PathBuf) -> Self {
        Self {
            system_folder,
            library_folder,
            allowed_cover_hosts: default_allowed_cover_hosts(),
        }
    }
}

impl Default for ImporterConfig {
    fn default() -> Self {
        Self::new(default_system_folder(), default_library_folder())
    }
}

/// `%APPDATA%/<BUNDLE_ID>/config.json` on Windows; `~/.config/<BUNDLE_ID>/config.json`
/// elsewhere. Falls back to the current directory if the platform's
/// config dir is somehow unavailable (e.g. headless CI container).
pub fn default_config_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join(BUNDLE_ID).join(CONFIG_FILE)
}

pub fn load(path: &Path) -> Result<ImporterConfig, ConfigError> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| ConfigError::Io(path.to_path_buf(), e.to_string()))?;
    serde_json::from_str(&raw).map_err(|e| ConfigError::Parse(e.to_string()))
}

pub fn save(path: &Path, cfg: &ImporterConfig) -> Result<(), ConfigError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| ConfigError::Io(parent.to_path_buf(), e.to_string()))?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| ConfigError::Serialize(e.to_string()))?;
    std::fs::write(path, json).map_err(|e| ConfigError::Io(path.to_path_buf(), e.to_string()))
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("config io {0}: {1}")]
    Io(PathBuf, String),
    #[error("config parse: {0}")]
    Parse(String),
    #[error("config serialize: {0}")]
    Serialize(String),
}

fn default_system_folder() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".nightingale")
}

fn default_library_folder() -> PathBuf {
    if cfg!(target_os = "windows") {
        // `%USERPROFILE%\Music` per Microsoft's Known Folders spec; the
        // main app's Playwright-tested build also defaults here.
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            return PathBuf::from(profile).join("Music");
        }
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join("Music")
}

fn default_allowed_cover_hosts() -> Vec<String> {
    // Placeholder allowlist. Coordinate with the catalog team before
    // shipping a release — a frozen signed-R2 host is the typical case.
    vec![
        "localhost".to_string(),
        "cdn.nightingale-catalog.example.com".to_string(),
        "r2.dev".to_string(),
        "pub-*.r2.dev".to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_round_trip() {
        let cfg = ImporterConfig::default();
        let json = serde_json::to_string(&cfg).expect("serialize");
        let back: ImporterConfig = serde_json::from_str(&json).expect("parse");
        assert_eq!(cfg, back);
    }

    #[test]
    fn missing_allowed_cover_hosts_defaults() {
        let json = r#"{
            "system_folder": "C:/Users/u/.nightingale",
            "library_folder": "C:/Users/u/Music"
        }"#;
        let cfg: ImporterConfig = serde_json::from_str(json).expect("parse");
        assert!(!cfg.allowed_cover_hosts.is_empty());
    }

    #[test]
    fn save_creates_parent_dirs() {
        let dir = std::env::temp_dir().join(format!(
            "ngl-importer-config-{}",
            std::process::id()
        ));
        let path = dir.join("nested").join("config.json");
        save(&path, &ImporterConfig::default()).expect("save");
        let back = load(&path).expect("load");
        assert_eq!(back, ImporterConfig::default());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
