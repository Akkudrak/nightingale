//! Song row CRUD.
//!
//! Everything that creates, updates, deletes, or fetches `songs` rows lives
//! here. The hot helpers `song_to_payload`, `INSERT_SONG_SQL`,
//! `insert_song_row_prepared`, and `load_song_from_payload_column` are
//! `pub(crate)` so sibling submodules (queries, migrations) reuse them
//! without copy-pasting the column lists.

use rusqlite::params;
use rusqlite::{Connection, OptionalExtension};

use crate::song::{Song, TranscriptSource};

use super::connection::{with_conn, with_conn_mut};
use super::scan_generation_is_current;

pub(crate) fn song_to_payload(song: &Song) -> rusqlite::Result<String> {
    serde_json::to_string(song).map_err(|e| {
        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            e.to_string(),
        )))
    })
}

pub(crate) fn transcript_source_to_db(t: Option<TranscriptSource>) -> Option<String> {
    t.map(|s| match s {
        TranscriptSource::Lyrics => "lyrics".to_string(),
        TranscriptSource::Generated => "generated".to_string(),
        TranscriptSource::Usdx => "usdx".to_string(),
        TranscriptSource::Lrc => "lrc".to_string(),
    })
}

pub(crate) const INSERT_SONG_SQL: &str = "\
INSERT INTO songs (path, file_hash, title, artist, album, duration_secs, album_art_path,
    is_analyzed, language, transcript_source, is_video, genre, added_at, payload)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)";

pub(crate) fn insert_song_row_prepared(
    stmt: &mut rusqlite::Statement<'_>,
    song: &Song,
) -> rusqlite::Result<()> {
    let payload = song_to_payload(song)?;
    let album_art = song
        .album_art_path
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());
    stmt.execute(params![
        song.path.to_string_lossy(),
        song.file_hash,
        song.title,
        song.artist,
        song.album,
        song.duration_secs,
        album_art,
        song.is_analyzed as i32,
        song.language,
        transcript_source_to_db(song.transcript_source),
        song.is_video as i32,
        song.genre,
        song.added_at,
        payload,
    ])?;
    Ok(())
}

pub(crate) fn load_song_from_payload_column(r: &rusqlite::Row<'_>) -> rusqlite::Result<Song> {
    let payload: String = r.get(0)?;
    serde_json::from_str(&payload).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

pub(crate) fn read_library_meta() -> rusqlite::Result<(String, usize)> {
    with_conn(|c| {
        c.query_row(
            "SELECT folder, scan_count FROM library_meta WHERE id = 1",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize)),
        )
    })
}

pub(crate) fn update_library_meta(folder: &str, scan_count: usize) -> rusqlite::Result<()> {
    with_conn_mut(|c| {
        c.execute(
            "UPDATE library_meta SET folder = ?1, scan_count = ?2 WHERE id = 1",
            params![folder, scan_count as i64],
        )?;
        Ok(())
    })
}

pub(crate) fn load_song_path_strings() -> rusqlite::Result<std::collections::HashSet<String>> {
    with_conn(|c| {
        let mut stmt = c.prepare("SELECT path FROM songs")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let v: Vec<String> = rows.collect::<Result<Vec<_>, _>>()?;
        Ok(v.into_iter().collect())
    })
}

pub(crate) fn append_songs(songs: &[Song]) -> rusqlite::Result<()> {
    if songs.is_empty() {
        return Ok(());
    }
    with_conn_mut(|c| {
        let tx = c.transaction()?;
        {
            let mut stmt = tx.prepare(INSERT_SONG_SQL)?;
            for song in songs {
                insert_song_row_prepared(&mut stmt, song)?;
            }
        }
        tx.commit()?;
        Ok(())
    })
}

pub(crate) fn append_songs_for_scan(songs: &[Song], generation: u64) -> rusqlite::Result<()> {
    if songs.is_empty() || !scan_generation_is_current(generation) {
        return Ok(());
    }
    with_conn_mut(|c| {
        let tx = c.transaction()?;
        {
            let mut stmt = tx.prepare(INSERT_SONG_SQL)?;
            for song in songs {
                if !scan_generation_is_current(generation) {
                    return Ok(());
                }
                insert_song_row_prepared(&mut stmt, song)?;
            }
        }
        if !scan_generation_is_current(generation) {
            return Ok(());
        }
        tx.commit()?;
        Ok(())
    })
}

pub(crate) fn replace_all_songs_sorted(songs: &[Song]) -> rusqlite::Result<()> {
    with_conn_mut(|c| {
        let tx = c.transaction()?;
        tx.execute("DELETE FROM songs", [])?;
        {
            let mut stmt = tx.prepare(INSERT_SONG_SQL)?;
            for song in songs {
                insert_song_row_prepared(&mut stmt, song)?;
            }
        }
        tx.commit()?;
        Ok(())
    })
}

pub(crate) fn delete_songs_not_in_paths(paths: &[String]) -> rusqlite::Result<()> {
    with_conn_mut(|c| {
        if paths.is_empty() {
            c.execute("DELETE FROM songs", [])?;
            return Ok(());
        }
        let placeholders = (1..=paths.len()).map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("DELETE FROM songs WHERE path NOT IN ({placeholders})");
        c.execute(
            &sql,
            rusqlite::params_from_iter(paths.iter().map(|s| s.as_str())),
        )?;
        Ok(())
    })
}

pub(crate) fn load_song_by_hash(file_hash: &str) -> rusqlite::Result<Option<Song>> {
    use rusqlite::OptionalExtension;
    with_conn(|c| {
        let mut stmt = c.prepare("SELECT payload FROM songs WHERE file_hash = ?1 LIMIT 1")?;
        let song = stmt
            .query_row([file_hash], |r| {
                let payload: String = r.get(0)?;
                serde_json::from_str::<Song>(&payload).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })
            })
            .optional()?;
        Ok(song)
    })
}

pub(crate) fn load_songs_by_hashes(file_hashes: &[String]) -> rusqlite::Result<Vec<Song>> {
    if file_hashes.is_empty() {
        return Ok(Vec::new());
    }

    with_conn(|c| {
        let placeholders = (1..=file_hashes.len())
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!("SELECT payload FROM songs WHERE file_hash IN ({placeholders})");
        let mut stmt = c.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params_from_iter(file_hashes.iter().map(String::as_str)),
            load_song_from_payload_column,
        )?;
        rows.collect()
    })
}

/// Rewrite a song row keyed by `old_hash` so its `file_hash`, `path`, and
/// JSON payload reflect a freshly downloaded source whose true Blake3 differs
/// from the placeholder we initially stored. Also points any pending row in
/// `analysis_queue` at the new hash so the in-flight scan keeps working.
pub(crate) fn rekey_song(old_hash: &str, new_hash: &str, new_song: &Song) -> rusqlite::Result<()> {
    let payload = song_to_payload(new_song)?;
    let album_art = new_song
        .album_art_path
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());
    with_conn_mut(|c| {
        let tx = c.transaction()?;
        tx.execute(
            "UPDATE songs SET file_hash = ?2, path = ?3, payload = ?4, album_art_path = ?5,
                title = ?6, artist = ?7, album = ?8, duration_secs = ?9,
                is_analyzed = ?10, language = ?11, transcript_source = ?12, is_video = ?13
             WHERE file_hash = ?1",
            params![
                old_hash,
                new_hash,
                new_song.path.to_string_lossy(),
                payload,
                album_art,
                new_song.title,
                new_song.artist,
                new_song.album,
                new_song.duration_secs,
                new_song.is_analyzed as i32,
                new_song.language,
                transcript_source_to_db(new_song.transcript_source),
                new_song.is_video as i32,
            ],
        )?;
        // `analysis_queue.file_hash` is the PK; UPDATE-OR-IGNORE shape covers
        // the (extremely unlikely) case where a row already exists for the
        // new hash.
        tx.execute(
            "DELETE FROM analysis_queue WHERE file_hash = ?1",
            params![new_hash],
        )?;
        tx.execute(
            "UPDATE analysis_queue SET file_hash = ?2 WHERE file_hash = ?1",
            params![old_hash, new_hash],
        )?;
        tx.commit()?;
        Ok(())
    })
}

pub(crate) fn update_song_fields(file_hash: &str, song: &Song) -> rusqlite::Result<()> {
    let payload = song_to_payload(song)?;
    let album_art = song
        .album_art_path
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());
    with_conn_mut(|c| {
        c.execute(
            "UPDATE songs SET title = ?2, artist = ?3, album = ?4, duration_secs = ?5,
                album_art_path = ?6, is_analyzed = ?7, language = ?8, transcript_source = ?9,
                is_video = ?10, payload = ?11
             WHERE file_hash = ?1",
            params![
                file_hash,
                song.title,
                song.artist,
                song.album,
                song.duration_secs,
                album_art,
                song.is_analyzed as i32,
                song.language,
                transcript_source_to_db(song.transcript_source),
                song.is_video as i32,
                payload,
            ],
        )?;
        Ok(())
    })
}

pub(crate) fn load_all_songs() -> rusqlite::Result<Vec<Song>> {
    with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT payload FROM songs ORDER BY artist COLLATE NOCASE, title COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], load_song_from_payload_column)?;
        rows.collect()
    })
}

/// Same query as [`load_all_songs`] but on a caller-supplied
/// `Connection`. Used by the standalone catalog importer (and any other
/// tool that opens a user `songs.db` with [`MigrateMode::ProbeOnly`](crate::library_db::migrations::MigrateMode))
/// without going through the process-wide singleton, so the importer's
/// read does not collide with a `Connection` the main Nightingale app
/// may have open on the same file.
pub(crate) fn load_all_songs_for_connection(c: &Connection) -> rusqlite::Result<Vec<Song>> {
    let mut stmt = c.prepare(
        "SELECT payload FROM songs ORDER BY artist COLLATE NOCASE, title COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], load_song_from_payload_column)?;
    rows.collect()
}

/// Single-hash lookup on a caller-supplied `Connection`. Mirrors
/// [`load_song_by_hash`] but without touching the singleton, so the
/// importer can use this against its own ProbeOnly connection.
pub(crate) fn load_song_by_hash_for_connection(
    c: &Connection,
    file_hash: &str,
) -> rusqlite::Result<Option<Song>> {
    let mut stmt = c.prepare("SELECT payload FROM songs WHERE file_hash = ?1 LIMIT 1")?;
    stmt.query_row([file_hash], load_song_from_payload_column)
        .optional()
}

#[cfg(test)]
mod tests_for_connection {
    //! Tests for [`load_all_songs_for_connection`] and
    //! [`load_song_by_hash_for_connection`]. They open an in-memory
    //! `Connection`, build the minimal `songs` table required by
    //! [`INSERT_SONG_SQL`], and round-trip a couple of rows through
    //! the JSON payload column. FTS5 and indexes from the full schema
    //! are not needed because these helpers only read the `payload`
    //! column.
    use super::*;
    use crate::song::{Song, SongOrigin};
    use rusqlite::Connection;

    fn make_song(file_hash: &str, title: &str, artist: &str, is_analyzed: bool) -> Song {
        Song {
            path: std::path::PathBuf::from(format!("/music/{file_hash}.mp3")),
            file_hash: file_hash.to_string(),
            title: title.to_string(),
            artist: artist.to_string(),
            album: "Test Album".to_string(),
            duration_secs: 180.0,
            album_art_path: None,
            is_analyzed,
            language: Some("en".to_string()),
            transcript_source: None,
            key: None,
            override_key: None,
            tempo: 1.0,
            key_offset: 0,
            is_video: false,
            usdx: None,
            origin: SongOrigin::LocalFile,
            no_stems: false,
            genre: None,
            added_at: 0,
        }
    }

    fn fresh_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open :memory:");
        conn.execute_batch(
            "CREATE TABLE songs (
                id INTEGER PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                file_hash TEXT NOT NULL,
                title TEXT NOT NULL,
                artist TEXT NOT NULL,
                album TEXT NOT NULL,
                duration_secs REAL NOT NULL,
                album_art_path TEXT,
                is_analyzed INTEGER NOT NULL,
                language TEXT,
                transcript_source TEXT,
                is_video INTEGER NOT NULL,
                genre TEXT,
                added_at INTEGER NOT NULL DEFAULT 0,
                payload TEXT NOT NULL
            );
            CREATE INDEX idx_songs_file_hash ON songs(file_hash);",
        )
        .expect("create songs table");
        conn
    }

    fn insert(conn: &Connection, song: &Song) {
        let mut stmt = conn
            .prepare(INSERT_SONG_SQL)
            .expect("prepare INSERT_SONG_SQL");
        insert_song_row_prepared(&mut stmt, song).expect("insert row");
    }

    #[test]
    fn load_all_songs_for_connection_round_trips_rows() {
        let conn = fresh_conn();
        let a = make_song("aaa", "Alpha", "Artist A", true);
        let b = make_song("bbb", "Beta", "Artist B", false);
        insert(&conn, &a);
        insert(&conn, &b);

        let rows = load_all_songs_for_connection(&conn).expect("load");
        assert_eq!(rows.len(), 2);
        // Order is artist/title COLLATE NOCASE ascending — "Artist A" < "Artist B".
        assert_eq!(rows[0].file_hash, "aaa");
        assert_eq!(rows[1].file_hash, "bbb");
        // Round-trip preserves the JSON payload fields used downstream.
        assert!(rows[0].is_analyzed);
        assert_eq!(rows[0].title, "Alpha");
        assert!(!rows[1].is_analyzed);
    }

    #[test]
    fn load_song_by_hash_for_connection_returns_some_and_none() {
        let conn = fresh_conn();
        let a = make_song("aaa", "Alpha", "Artist A", true);
        insert(&conn, &a);

        let found = load_song_by_hash_for_connection(&conn, "aaa")
            .expect("query")
            .expect("present");
        assert_eq!(found.title, "Alpha");
        assert_eq!(found.artist, "Artist A");

        let missing = load_song_by_hash_for_connection(&conn, "does-not-exist")
            .expect("query");
        assert!(missing.is_none());
    }
}
