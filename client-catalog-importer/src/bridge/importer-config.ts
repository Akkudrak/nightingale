//! Tauri command bridge for importer config.
//!
//! Mirrors `app_core::importer_config::{ImporterConfig, load, save}`. The
//! Tauri command set is exactly two methods (see `client-catalog-importer/
//! src-tauri/src/commands.rs`): one to read, one to write. Persistence
//! lives in Rust; this module just types the IPC and delegates.

import { invoke } from '@tauri-apps/api/core';

export type ImporterConfig = {
  systemFolder: string;
  libraryFolder: string;
  allowedCoverHosts: string[];
};

export const readImporterConfig = (): Promise<ImporterConfig | null> =>
  invoke<ImporterConfig | null>('read_importer_config');

export const writeImporterConfig = (config: ImporterConfig): Promise<void> =>
  invoke<void>('write_importer_config', { config });
