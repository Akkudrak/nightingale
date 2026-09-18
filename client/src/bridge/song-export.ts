//! Frontend wrappers for the full-song export / import Tauri commands.
//!
//! These carry the audio + cover + transcript + stems + lyrics + variants
//! + metadata in a single ZIP. On import the receiving Nightingale skips
//! the AI re-analysis pipeline (stem separation + transcription).
//!
//! For `importSongFull`: the Rust command resolves a destination folder
//! from `AppConfig.library_source` automatically. If none is configured,
//! the UI prompts the user for a folder before invoking.

import { open, save } from '@tauri-apps/plugin-dialog';

import { loadConfig } from './config';
import { invoke, isTauri } from './runtime';

export type ExportSongFullInput = {
  fileHash: string;
  title: string;
  artist: string;
};

export type ExportSongFullResult = {
  path: string;
  bytes: number;
};

export type ImportSongFullResult = {
  fileHash: string;
  title: string;
  artist: string;
  importedPath: string;
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

const pickZipPath = async (): Promise<string | null> => {
  if (!isTauri) {
    return null;
  }
  const zipPath: string | null = await open({
    title: 'Import Nightingale song ZIP',
    multiple: false,
    filters: [{ name: 'ZIP', extensions: ['zip'] }],
  });
  return zipPath;
};

const pickTargetFolder = async (): Promise<string | null> => {
  if (!isTauri) {
    return null;
  }
  const picked: string | null = await open({
    title: 'Choose a folder to import the audio into',
    directory: true,
    multiple: false,
  });
  return picked;
};

const resolveTargetLibraryDir = async (): Promise<string | null> => {
  try {
    const cfg = await loadConfig();
    const source = cfg.library_source;
    if (source && source.kind === 'folder' && source.path) {
      return source.path;
    }
  } catch {
    // loadConfig failure isn't fatal; fall through to the folder picker.
  }
  return pickTargetFolder();
};

export const exportSongFull = async (
  input: ExportSongFullInput,
): Promise<ExportSongFullResult | null> => {
  if (!isTauri) {
    return null;
  }

  const outputPath = await save({
    title: 'Export full Nightingale song (audio + analysis)',
    defaultPath: sanitizeFilename(input.title, input.artist),
    filters: [{ name: 'ZIP', extensions: ['zip'] }],
  });
  if (outputPath === null) {
    return null;
  }

  const bytes = await invoke<number>('export_song_full', {
    fileHash: input.fileHash,
    outputPath,
  });

  return { path: outputPath, bytes };
};

export const importSongFull = async (): Promise<ImportSongFullResult | null> => {
  const zipPath = await pickZipPath();
  if (zipPath === null) {
    return null;
  }

  const targetLibraryDir = await resolveTargetLibraryDir();
  if (targetLibraryDir === null) {
    return null;
  }

  const result = await invoke<ImportSongFullResult>('import_song_full', {
    zipPath,
    targetLibraryDir,
  });

  return result;
};
