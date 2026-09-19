/**
 * Bridge for the YouTube Data API v3 fallback search. The actual HTTP
 * call lives in Rust (`app-core::youtube::search_youtube`) and is
 * surfaced via two symmetric commands:
 *
 *   - Desktop: `#[tauri::command] fn search_youtube_videos(query)` at
 *     `client/src-tauri/src/playback.rs`.
 *   - `/guest` server: arm in
 *     `client/src-server/src/commands.rs::dispatch` keyed by name.
 *
 * `runtime::invoke` (`@/bridge/runtime`) routes the same call name to
 * whichever transport is active, so this bridge is intentionally
 * minimal — just a typed wrapper plus a trim guard.
 */

import type { YouTubeHit } from '@/types/YouTubeHit';

import { invoke } from './runtime';

export type { YouTubeHit };

export const searchYouTubeVideos = async (query: string): Promise<YouTubeHit[]> => {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return [];
  }
  return await invoke<YouTubeHit[]>('search_youtube_videos', { query: trimmed });
};
