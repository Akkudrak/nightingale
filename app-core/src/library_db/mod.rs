//! SQLite-backed library store.
//!
//! Split into focused submodules so each file owns one responsibility:
//!  - [`connection`] — the singleton `Connection` and `with_conn`/`with_conn_mut` guards
//!  - [`migrations`] — schema migrations, legacy `songs.json` import, and the one-shot
//!    Jellyfin path rewrite
//!  - [`analysis_queue`] — CRUD for the analyzer's persistent queue
//!  - [`songs`] — core song row CRUD, scan-aware inserts, rekey/update helpers
//!  - [`queries`] — search / pagination / library-menu aggregation queries
//!  - [`rebase`] — one-shot path rewrite when the data root moves
//!  - [`remote`] — generic helpers for non-local song origins (Jellyfin, Navidrome, …),
//!    keyed on `$.origin.kind` instead of duplicating SQL per source
//!
//! `mod.rs` is a thin barrel: it owns the small top-of-stack items
//! (`init_library`, `library_db_path`, the scan generation counter) and
//! re-exports everything else so external call sites keep writing
//! `library_db::foo(...)`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::Connection;

use crate::cache::nightingale_dir;
use crate::error::NightingaleError;

mod analysis_queue;
mod connection;
mod migrations;
mod playlists;
mod queries;
mod rebase;
pub(crate) mod remote;
mod songs;
mod text;

pub(crate) use analysis_queue::{
    analysis_queue_clear, analysis_queue_delete, analysis_queue_load_rows,
    analysis_queue_save_rows, analysis_queue_upsert_row,
};
pub(crate) use migrations::rewrite_legacy_jellyfin_paths;
pub(crate) use playlists::{PlaylistDefinition, PlaylistSongKeyKind, replace_all_playlists};
pub(crate) use queries::{
    iter_file_hashes_filtered_analysis_busy, iter_file_hashes_filtered_full_reanalyzable,
    iter_file_hashes_filtered_not_analyzed, iter_file_hashes_filtered_realignable,
    iter_file_hashes_filtered_refreshable, load_meta_sql, load_songs_page,
    query_library_menu_items,
};
pub(crate) use rebase::{rebase_song_album_art_cache_paths, rebase_song_album_art_paths};
pub(crate) use songs::{
    append_songs, append_songs_for_scan, delete_songs_not_in_paths, load_all_songs,
    load_song_by_hash, load_song_path_strings, load_songs_by_hashes, read_library_meta, rekey_song,
    replace_all_songs_sorted, update_library_meta, update_song_fields,
};

/// Incremented at the start of each `start_scan` so in-flight scan threads stop writing
/// after the library is cleared or replaced (folder change / new scan).
static SCAN_GENERATION: AtomicU64 = AtomicU64::new(0);

pub(crate) fn bump_scan_generation() -> u64 {
    SCAN_GENERATION.fetch_add(1, Ordering::SeqCst) + 1
}

pub(crate) fn scan_generation_is_current(generation: u64) -> bool {
    SCAN_GENERATION.load(Ordering::SeqCst) == generation
}

pub fn library_db_path() -> PathBuf {
    nightingale_dir().join("songs.db")
}

pub fn init_library() -> rusqlite::Result<()> {
    if connection::is_initialised() {
        return Ok(());
    }
    let conn = connection::open_connection(&library_db_path())?;
    connection::install(conn)?;
    analysis_queue::import_legacy_analysis_queue_json()?;
    migrations::maybe_start_songs_json_migration();
    Ok(())
}

pub(crate) fn reconnect_library_at_root(root: &Path) -> Result<(), String> {
    let db_path = root.join("songs.db");
    let conn = connection::open_connection(&db_path)
        .map_err(|e| format!("failed opening migrated songs db: {e}"))?;
    connection::replace_or_install(conn)
}

/// Open (or create) a `songs.db` at an arbitrary `system_folder` for
/// the standalone catalog importer.
///
/// The returned `Connection` is **not** installed into the
/// process-wide `LIBRARY_DB` so it does not collide with whatever the
/// main Nightingale app (if any) has open in the same process.
/// Caller is responsible for dropping the connection when done.
///
/// Schema migrations are intentionally skipped (`MigrateMode::ProbeOnly`)
/// so the user's existing `songs.db` is never promoted forward
/// behind their back. The importer writes only the columns that
/// `PRAGMA table_info(songs)` reports as already present.
pub fn open_library_db_for_import(system_folder: &Path) -> Result<Connection, NightingaleError> {
    if !system_folder.is_dir() {
        std::fs::create_dir_all(system_folder)
            .map_err(|e| NightingaleError::Other(format!("create system folder: {e}")))?;
    }
    let db_path = system_folder.join("songs.db");
    connection::open_connection_with_mode(&db_path, migrations::MigrateMode::ProbeOnly)
        .map_err(|e| NightingaleError::Other(format!("open user songs.db: {e}")))
}
