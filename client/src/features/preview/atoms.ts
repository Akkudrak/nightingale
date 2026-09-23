import { atom } from 'jotai';

/**
 * Snapshot of the song currently being previewed in the global player bar.
 *
 * `no_stems` is captured alongside the song so the preview bar can decide
 * whether to mount the guide-vocals `<audio>` element without re-fetching
 * the song; the LRU cache in `use-preview-playback` holds the resolved
 * URLs so flipping between rows doesn't re-run `getAudioPaths`.
 */
export type PreviewSong = {
  hash: string;
  title: string;
  artist: string;
  path: string;
  isAnalyzed: boolean;
  noStems: boolean;
};

export const previewSongAtom = atom<PreviewSong | null>(null);
