//! One-shot rewrite of `album_art_path` columns when the data root moves.

use std::path::Path;

use diesel::prelude::*;

use crate::error::NightingaleError;

use super::connection::database_url;
use super::schema::songs;

fn maybe_rebase_string_path(path: &str, old_root: &Path, new_root: &Path) -> Option<String> {
    let relative = Path::new(path).strip_prefix(old_root).ok()?;
    Some(new_root.join(relative).to_string_lossy().into_owned())
}

fn rebase_song_album_art_paths_in_db(
    db_path: &Path,
    old_root: &Path,
    new_root: &Path,
) -> Result<(), String> {
    if !db_path.is_file() || crate::cache::same_path(old_root, new_root) {
        return Ok(());
    }

    let database_url = database_url(db_path)
        .map_err(|error| format!("failed resolving songs db path {db_path:?}: {error}"))?;
    let mut conn = SqliteConnection::establish(&database_url)
        .map_err(|error| format!("failed opening songs db {db_path:?}: {error}"))?;

    conn.transaction::<_, NightingaleError, _>(|conn| {
        let rows = songs::table
            .select((songs::id, songs::album_art_path, songs::payload))
            .load::<(i64, Option<String>, String)>(conn)?;

        for (id, album_art_path, payload) in rows {
            let mut changed = false;
            let mut new_album_art = album_art_path.clone();
            if let Some(current) = album_art_path.as_deref()
                && let Some(rebased) = maybe_rebase_string_path(current, old_root, new_root)
            {
                new_album_art = Some(rebased);
                changed = true;
            }

            let mut new_payload = payload.clone();
            if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&payload)
                && let Some(album_art_value) = value.get_mut("album_art_path")
                && let Some(current) = album_art_value.as_str()
                && let Some(rebased) = maybe_rebase_string_path(current, old_root, new_root)
            {
                *album_art_value = serde_json::Value::String(rebased);
                if let Ok(serialized) = serde_json::to_string(&value) {
                    new_payload = serialized;
                    changed = true;
                }
            }

            if changed {
                diesel::update(songs::table.find(id))
                    .set((
                        songs::album_art_path.eq(new_album_art),
                        songs::payload.eq(new_payload),
                    ))
                    .execute(conn)?;
            }
        }
        Ok(())
    })
    .map_err(|error| format!("failed rewriting songs db paths: {error}"))
}

pub(crate) fn rebase_song_album_art_paths(old_root: &Path, new_root: &Path) -> Result<(), String> {
    rebase_song_album_art_paths_in_db(&new_root.join("songs.db"), old_root, new_root)
}

pub(crate) fn rebase_song_album_art_cache_paths(
    old_cache: &Path,
    new_cache: &Path,
) -> Result<(), String> {
    rebase_song_album_art_paths_in_db(&super::library_db_path(), old_cache, new_cache)
}
