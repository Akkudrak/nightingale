//! SingVerse fork: karaoke rooms download pre-analyzed `.nge` bundles from the
//! SingVerse catalogue into the pinned folder library. These helpers register a
//! single bundle (or forget an evicted one) without a full library rescan, so a
//! queued song becomes playable seconds after its download finishes.

use std::path::Path;

use crate::{
    cache::CacheDir,
    error::NightingaleError,
    library_db,
    song::{Song, build_nge_song},
};

/// Validates the bundle, adds it to the library unless a row with the same
/// file hash already exists, and returns the song as Nightingale knows it
/// (its `file_hash` is the BLAKE3 of the whole `.nge`, not the manifest's).
pub fn import_nge_bundle(path: &Path) -> Result<Song, NightingaleError> {
    let cache = CacheDir::new();
    let song = build_nge_song(path, &cache)?;

    if let Some(existing) = library_db::load_song_by_hash(&song.file_hash)? {
        return Ok(existing);
    }

    library_db::append_songs(std::slice::from_ref(&song))?;
    Ok(song)
}

/// Drops library rows whose files are no longer among `kept_paths` (bundles
/// evicted from the download cache).
pub fn prune_library_paths(kept_paths: &[String]) -> Result<(), NightingaleError> {
    library_db::delete_songs_not_in_paths(kept_paths)
}

/// The room's join link as an SVG QR code for the screen.
pub fn qr_svg(data: &str) -> Result<String, String> {
    crate::remote_control::qr_svg(data)
}
