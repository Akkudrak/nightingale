//! Process-wide SQLite connection guard.
//!
//! `LIBRARY_DB` is a `OnceLock<Mutex<Connection>>` set by [`super::init_library`]
//! and re-pointable by [`super::reconnect_library_at_root`]. Every read/write
//! goes through [`with_conn`] / [`with_conn_mut`] so we never hand out raw
//! connection references and the mutex scope stays tight.

use std::path::Path;
use std::sync::{Mutex, OnceLock};

use rusqlite::Connection;
use rusqlite::functions::FunctionFlags;

use super::migrations::{run_migrations_with_mode, MigrateMode};
use super::text::fold_accents;

static LIBRARY_DB: OnceLock<Mutex<Connection>> = OnceLock::new();

fn lock_error() -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_MISUSE),
        Some("library db connection lock poisoned".into()),
    )
}

pub(super) fn is_initialised() -> bool {
    LIBRARY_DB.get().is_some()
}

pub(super) fn install(conn: Connection) -> rusqlite::Result<()> {
    LIBRARY_DB.set(Mutex::new(conn)).map_err(|_| {
        rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_MISUSE),
            Some("library db already initialized".into()),
        )
    })
}

pub(super) fn replace_or_install(conn: Connection) -> Result<(), String> {
    if let Some(existing) = LIBRARY_DB.get() {
        let mut guard = existing
            .lock()
            .map_err(|_| "library db connection lock poisoned")?;
        *guard = conn;
        return Ok(());
    }
    LIBRARY_DB
        .set(Mutex::new(conn))
        .map_err(|_| "failed initializing library db connection".to_string())
}

pub(super) fn open_connection(path: &Path) -> rusqlite::Result<Connection> {
    open_connection_with_mode(path, MigrateMode::Forward)
}

/// Open the SQLite file at `path` with the given migration mode,
/// **without** installing the connection into the process-wide
/// `LIBRARY_DB` `OnceLock`. Used by the standalone catalog importer
/// ([`super::open_library_db_for_import`]) so a user-supplied
/// `songs.db` can be opened at any `PRAGMA user_version` without
/// being silently promoted to the current schema.
pub(super) fn open_connection_with_mode(
    path: &Path,
    mode: MigrateMode,
) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(path)?;
    run_migrations_with_mode(&conn, mode)?;
    install_text_functions(&conn)?;
    Ok(conn)
}

/// Mirror [`super::text::fold_accents`] inside SQLite as a custom
/// scalar so search predicates can compare against an
/// accent-stripped copy of each metadata column without a schema
/// migration or a per-row denormalised blob.
///
/// `SQLITE_UTF8` tells the engine the function operates on UTF-8
/// text rather than raw BLOB bytes; `SQLITE_DETERMINISTIC` lets the
/// planner cache invocations and reuse the same folded value across
/// identical rows.
fn install_text_functions(conn: &Connection) -> rusqlite::Result<()> {
    conn.create_scalar_function(
        "unaccent",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx: &rusqlite::functions::Context<'_>| -> rusqlite::Result<String> {
            let s: String = ctx.get(0)?;
            Ok(fold_accents(&s))
        },
    )
}

pub(crate) fn with_conn<T, F: FnOnce(&Connection) -> rusqlite::Result<T>>(
    f: F,
) -> rusqlite::Result<T> {
    let g = LIBRARY_DB
        .get()
        .ok_or_else(|| {
            rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_MISUSE),
                Some("init_library not called".into()),
            )
        })?
        .lock()
        .map_err(|_| lock_error())?;
    f(&g)
}

pub(crate) fn with_conn_mut<T, F: FnOnce(&mut Connection) -> rusqlite::Result<T>>(
    f: F,
) -> rusqlite::Result<T> {
    let mut g = LIBRARY_DB
        .get()
        .ok_or_else(|| {
            rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_MISUSE),
                Some("init_library not called".into()),
            )
        })?
        .lock()
        .map_err(|_| lock_error())?;
    f(&mut g)
}
