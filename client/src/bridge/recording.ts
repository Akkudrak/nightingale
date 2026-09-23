import { convertFileSrc } from '@/bridge/media';
import type { RecordingRecord } from '@/types/RecordingRecord';

import { invoke, isTauri } from './runtime';

/**
 * Bridge for the karaoke microphone recording history.
 *
 * The server keeps the source of truth in `app_core::RecordingStore`:
 * rows in a JSON index (`recordings.json`) plus `<id>.wav` files under
 * the data folder. The audio is uploaded as base64 inside a JSON body
 * to fit the existing `/api/cmd/<name>` dispatcher — a 3-minute mono
 * recording at 44.1 kHz / 16-bit stays well under 25 MB encoded.
 *
 * In Tauri mode the same call site goes through `invoke()`; the Rust
 * command in `client/src-tauri/src/recording.rs` writes the bytes
 * directly, bypassing the HTTP body altogether.
 */

export type SaveRecordingInput = {
  songHash: string;
  songTitle: string;
  songArtist: string;
  score: number;
  durationSecs: number;
  sampleRate: number;
  /**
   * Unix seconds at which the take ended — the same value the result dialog
   * just sent to `add_score`. Lets the recording row join the score row
   * exactly in the history view.
   */
  playedAt: number;
  /** Base64-encoded WAV bytes; the server decodes + writes to disk. */
  wavBase64: string;
};

export const loadRecordings = (): Promise<RecordingRecord[]> =>
  invoke<RecordingRecord[]>('load_recordings');

export const saveRecording = (input: SaveRecordingInput): Promise<string> =>
  invoke<string>('save_recording', {
    songHash: input.songHash,
    songTitle: input.songTitle,
    songArtist: input.songArtist,
    score: input.score,
    durationSecs: input.durationSecs,
    sampleRate: input.sampleRate,
    playedAt: input.playedAt,
    wavBase64: input.wavBase64,
  });

export const deleteRecording = (id: string): Promise<void> =>
  invoke<void>('delete_recording', { id });

/**
 * Resolves a playable URL for a recording's WAV blob.
 *
 * - Web mode: the server exposes `/api/recording/<id>` (see
 *   `client/src-server/src/main.rs`). The handler canonicalises the id
 *   against the recordings folder so a stray `..` segment is rejected.
 * - Tauri mode: the desktop build does not run the HTTP layer, so we
 *   ask the Rust side for the absolute WAV path and hand it to the
 *   asset protocol via `convertFileSrc`. The data folder is already
 *   in `asset_protocol_scope` (see `lib.rs::run`'s setup hook).
 *
 * Always returns a promise so the consumer doesn't have to branch on
 * transport. In web mode the promise is already settled by the time
 * it's awaited; the cost is one extra microtask tick.
 */
export const recordingUrl = (id: string): Promise<string> => {
  if (!isTauri) {
    return Promise.resolve(`/api/recording/${encodeURIComponent(id)}`);
  }
  return invoke<string | null>('get_recording_path', { id }).then((path) => {
    if (typeof path !== 'string' || path === '') {
      return '';
    }
    return convertFileSrc(path);
  });
};
