//! Process-wide SQLite connection guard.
//!
//! `LIBRARY_DB` is a `OnceLock<Mutex<SqliteConnection>>` set by
//! [`super::init_library`] and re-pointable by [`super::reconnect_library_at_root`].
//! Every operation goes through [`with_conn`] so the mutex scope stays tight.

use std::path::Path;
use std::sync::{Mutex, OnceLock};

use diesel::prelude::*;
use diesel::sqlite::SqliteConnection;

use crate::error::NightingaleError;

use super::migrations::{configure, run_migrations};
use super::sql_functions::{normalize_search, search_normalize_utils};

static LIBRARY_DB: OnceLock<Mutex<SqliteConnection>> = OnceLock::new();

pub(super) fn is_initialised() -> bool {
    LIBRARY_DB.get().is_some()
}

pub(super) fn install(conn: SqliteConnection) -> Result<(), NightingaleError> {
    LIBRARY_DB
        .set(Mutex::new(conn))
        .map_err(|_| NightingaleError::from("library db already initialized"))
}

pub(super) fn replace_or_install(conn: SqliteConnection) -> Result<(), String> {
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

pub(super) fn database_url(path: &Path) -> Result<String, NightingaleError> {
    if let Some(path) = path.to_str() {
        return Ok(path.to_string());
    }

    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;

        let mut url = String::from("file:");
        for byte in path.as_os_str().as_bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'-' | b'_' | b'~') {
                url.push(char::from(*byte));
            } else {
                use std::fmt::Write;
                write!(url, "%{byte:02X}")
                    .map_err(|error| NightingaleError::from(error.to_string()))?;
            }
        }
        Ok(url)
    }

    #[cfg(not(unix))]
    Err(NightingaleError::from(
        "library db path cannot be represented as UTF-8",
    ))
}

pub(super) fn open_connection(path: &Path) -> Result<SqliteConnection, NightingaleError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let database_url = database_url(path)?;
    let mut conn = SqliteConnection::establish(&database_url)?;
    search_normalize_utils::register_impl(&mut conn, |input: String| normalize_search(&input))?;
    configure(&mut conn)?;
    run_migrations(&mut conn)?;
    Ok(conn)
}

pub(crate) fn with_conn<T>(
    f: impl FnOnce(&mut SqliteConnection) -> Result<T, NightingaleError>,
) -> Result<T, NightingaleError> {
    let mut guard = LIBRARY_DB
        .get()
        .ok_or_else(|| NightingaleError::from("init_library not called"))?
        .lock()
        .map_err(|_| NightingaleError::from("library db connection lock poisoned"))?;
    f(&mut guard)
}

pub(crate) fn with_conn_mut<T>(
    f: impl FnOnce(&mut SqliteConnection) -> Result<T, NightingaleError>,
) -> Result<T, NightingaleError> {
    with_conn(f)
}
