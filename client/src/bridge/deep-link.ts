// Bridge for the desktop-side `deep-link-import-done` event.
//
// The Rust handler (`client/src-tauri/src/deep_link.rs`) downloads and
// imports the song that a `nightingale://catalog/v1/import?p=…` deep
// link references, then emits a single `deep-link-import-done` event
// with a `DeepLinkImportDone` payload. This wrapper is the TS-side
// counterpart — a typed, Zod-validated `listen()` so consumers in the
// React tree can toast and invalidate their song queries.
//
// Mirrors `bridge/analysis.ts:61-67` (the `onShiftKeyDone` /
// `onShiftTempoDone` pattern).

import { z } from 'zod';

import { listen } from './runtime';

const deepLinkImportDoneSchema = z.object({
  ok: z.boolean(),
  fileHash: z.string().nullish(),
  title: z.string().nullish(),
  artist: z.string().nullish(),
  importedPath: z.string().nullish(),
  error: z.string().nullish(),
});

export type DeepLinkImportDone = z.infer<typeof deepLinkImportDoneSchema>;

export const onDeepLinkImportDone = async (
  cb: (payload: DeepLinkImportDone) => void,
): Promise<() => void> => {
  return await listen<DeepLinkImportDone>('deep-link-import-done', ({ payload }) =>
    cb(deepLinkImportDoneSchema.parse(payload)),
  );
};
