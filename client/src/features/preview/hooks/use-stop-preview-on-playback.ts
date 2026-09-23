/**
 * Bridge that snaps the preview bar shut the moment karaoke playback
 * actually starts. The karaoke audio engine owns the output device, so
 * letting the preview keep going would cause a stutter on the instrumentals
 * and a brief mix of pre-analyzed vocals on top of the live playback.
 *
 * Watched: route changes to `/playback`. The karaoke engine only mounts
 * under that route (see `client/src/features/playback/playback.tsx`), so a
 * route change is the cleanest signal without depending on the playback
 * provider — which is unavailable in the menu tree.
 */

import { useEffect } from 'react';
import { useLocation } from 'react-router';

import { usePreviewControls } from '@/features/preview/hooks/use-preview-controls';

export const useStopPreviewOnPlayback = (): void => {
  const { activeSong, stop } = usePreviewControls();
  const { pathname } = useLocation();

  useEffect(() => {
    if (activeSong === null) {
      return;
    }
    if (pathname.startsWith('/playback')) {
      stop();
    }
  }, [activeSong, pathname, stop]);
};
