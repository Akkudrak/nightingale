//! Frontend wrapper for the catalog-export Tauri command.
//!
//! Opens a save dialog (Tauri only), then asks the Rust side to read
//! `song.path` from the library DB and write a Nightingale-Catalog-
//! compatible ZIP to the chosen path. Returns `{ path, bytes }` so the
//! caller can show a "Exported N KB to …" toast, or `null` when the user
//! cancels the save dialog.
//!
//! The web/headless build can't open a native save dialog, so we resolve
//! `null` immediately — the action button should be hidden in that mode
//! (or wired to an HTTP endpoint that takes a server-side path).

import { save } from '@tauri-apps/plugin-dialog';

import { invoke, isTauri } from './runtime';

export type ExportSongInput = {
  fileHash: string;
  title: string;
  artist: string;
};

export type ExportSongResult = {
  path: string;
  bytes: number;
};

const sanitizeFilename = (title: string, artist: string): string => {
  const raw = `${title}-${artist}.zip`;
  return (
    raw
      .replace(/[^a-z0-9.-]/gi, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 120) || 'song.zip'
  );
};

export const exportSongCatalogZip = async (
  input: ExportSongInput,
): Promise<ExportSongResult | null> => {
  if (!isTauri) {
    // Headless / browser preview: no native dialog. The action UI should
    // hide itself in this mode; we just no-op here.
    return null;
  }

  const outputPath = await save({
    title: 'Export Nightingale catalog ZIP',
    defaultPath: sanitizeFilename(input.title, input.artist),
    filters: [{ name: 'ZIP', extensions: ['zip'] }],
  });

  if (outputPath === null) {
    return null;
  }

  const bytes = await invoke<number>('export_song_catalog_zip', {
    fileHash: input.fileHash,
    outputPath,
  });

  return { path: outputPath, bytes };
};
