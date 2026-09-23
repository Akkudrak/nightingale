//! Tauri event bridge for `deep-link-import-done`.
//!
//! `client-catalog-importer/src-tauri/src/deep_link.rs` emits one event
//! per `nightingale-import://` URL it finishes processing. The shape
//! mirrors `app_core::catalog_import::CatalogImportDone`:
//! `{ ok, fileHash?, title?, artist?, importedPath?, error? }`.

import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type CatalogImportDone = {
  ok: boolean;
  fileHash?: string | null;
  title?: string | null;
  artist?: string | null;
  importedPath?: string | null;
  error?: string | null;
};

export const EVENT_NAME = 'deep-link-import-done';

export const onDeepLinkImportDone = (
  handler: (payload: CatalogImportDone) => void,
): Promise<UnlistenFn> => listen<CatalogImportDone>(EVENT_NAME, (event) => handler(event.payload));
