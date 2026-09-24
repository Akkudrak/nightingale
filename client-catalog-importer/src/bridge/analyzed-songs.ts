//! Tauri command bridge for the export-your-songs feature.
//!
//! Two commands:
//! - `list_analyzed_songs` enumerates the user's analysed songs from
//!   `songs.db` so the modal can populate its checkboxes.
//! - `export_song_zips` writes one catalog bundle per selected song
//!   into a user-chosen destination folder. The IPC returns
//!   immediately; per-zip results stream back as `export-song-done`
//!   events that `StatusView` subscribes to.

import { invoke } from '@tauri-apps/api/core';

export type SongSummary = {
  fileHash: string;
  title: string;
  artist: string;
  album: string;
  durationSecs: number;
  isAnalyzed: boolean;
};

export const listAnalyzedSongs = (): Promise<SongSummary[]> =>
  invoke<SongSummary[]>('list_analyzed_songs');

export const exportSongZips = (
  fileHashes: readonly string[],
  destDir: string,
): Promise<void> =>
  invoke<void>('export_song_zips', {
    fileHashes: [...fileHashes],
    destDir,
  });
