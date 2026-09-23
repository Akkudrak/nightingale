import { useAtom, useAtomValue } from 'jotai';
import { useCallback } from 'react';

import type { Song } from '@/types/Song';

import { previewSongAtom, type PreviewSong } from '../atoms';

/**
 * Thin wrapper around `previewSongAtom` that hides the store shape from
 * callers. Row buttons only need to know "is mine active?" and "start me".
 */
export const usePreviewControls = () => {
  const [active, setActive] = useAtom(previewSongAtom);

  const isActive = useCallback(
    (song: Song): boolean => active !== null && active.hash === song.file_hash,
    [active],
  );

  const start = useCallback(
    (song: Song): void => {
      const next: PreviewSong = {
        hash: song.file_hash,
        title: song.title,
        artist: song.artist,
        path: song.path,
        isAnalyzed: song.is_analyzed,
        noStems: song.no_stems,
      };
      setActive((prev) => (prev !== null && prev.hash === next.hash ? prev : next));
    },
    [setActive],
  );

  const stop = useCallback((): void => {
    setActive(null);
  }, [setActive]);

  return {
    activeSong: active,
    isActive,
    start,
    stop,
  };
};

/** Read-only variant for components that don't need to mutate the atom. */
export const usePreviewSong = (): PreviewSong | null => useAtomValue(previewSongAtom);
