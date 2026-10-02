//! Helpers for songs keyed by remote `origin.item_id` values.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use diesel::prelude::*;

use crate::error::NightingaleError;
use crate::song::Song;

use super::connection::{with_conn, with_conn_mut};
use super::schema::songs;
use super::songs::update_song_fields;
use super::sql_functions::json_extract_text;

pub(crate) fn load_remote_item_ids(kind: &str) -> Result<HashSet<String>, NightingaleError> {
    with_conn(|conn| {
        let ids = songs::table
            .filter(json_extract_text(songs::payload, "$.origin.kind").eq(kind))
            .select(json_extract_text(songs::payload, "$.origin.item_id"))
            .load::<Option<String>>(conn)?;
        Ok(ids.into_iter().flatten().collect())
    })
}

pub(crate) fn load_remote_cover_tags(
    kind: &str,
) -> Result<HashMap<String, Option<String>>, NightingaleError> {
    with_conn(|conn| {
        let rows = songs::table
            .filter(json_extract_text(songs::payload, "$.origin.kind").eq(kind))
            .select((
                json_extract_text(songs::payload, "$.origin.item_id"),
                json_extract_text(songs::payload, "$.origin.cover_tag"),
            ))
            .load::<(Option<String>, Option<String>)>(conn)?;
        Ok(rows
            .into_iter()
            .filter_map(|(id, tag)| id.map(|id| (id, tag)))
            .collect())
    })
}

pub(crate) fn refresh_remote_cover_for_item<F>(
    kind: &str,
    item_id: &str,
    fetch: F,
) -> Result<(), NightingaleError>
where
    F: FnOnce(&str) -> Option<PathBuf>,
{
    let song_row = with_conn(|conn| {
        Ok(songs::table
            .filter(json_extract_text(songs::payload, "$.origin.kind").eq(kind))
            .filter(json_extract_text(songs::payload, "$.origin.item_id").eq(item_id))
            .select((songs::file_hash, songs::payload))
            .first::<(String, String)>(conn)
            .optional()?)
    })?;
    let Some((file_hash, payload)) = song_row else {
        return Ok(());
    };
    let mut song: Song = match serde_json::from_str(&payload) {
        Ok(song) => song,
        Err(_) => return Ok(()),
    };
    let new_cover = fetch(item_id);
    if new_cover.is_none()
        && let Some(slot) = song.origin.cover_tag_mut()
    {
        *slot = None;
    }
    song.album_art_path = new_cover;
    update_song_fields(&file_hash, &song)
}

pub(crate) fn delete_remote_songs_not_in_item_ids(
    kind: &str,
    item_ids: &[String],
) -> Result<(), NightingaleError> {
    with_conn_mut(|conn| {
        let matching_kind = json_extract_text(songs::payload, "$.origin.kind").eq(kind);
        if item_ids.is_empty() {
            diesel::delete(songs::table.filter(matching_kind)).execute(conn)?;
        } else {
            diesel::delete(
                songs::table.filter(
                    matching_kind.and(
                        json_extract_text(songs::payload, "$.origin.item_id").ne_all(item_ids),
                    ),
                ),
            )
            .execute(conn)?;
        }
        Ok(())
    })
}
