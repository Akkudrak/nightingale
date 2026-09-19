import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import {
  reservePlaybackTarget,
  savePlaybackSession,
  showPlaybackTarget,
  type PlaybackSession,
  type PlaybackTarget,
} from '@/bridge/playback-session';
import { useConfig } from '@/shared/config/use-config';

export function usePlaybackLauncher() {
  const navigate = useNavigate();
  const { data: config } = useConfig();
  const sessionMode = config?.playback_mode === 'session';

  const reserveTarget = (): PlaybackTarget => {
    const target = sessionMode ? reservePlaybackTarget() : null;
    if (target === undefined) {
      toast.error('Allow pop-ups to open the playback tab');
    }
    return target;
  };

  const launch = async (session: PlaybackSession, target: PlaybackTarget): Promise<void> => {
    try {
      if (!sessionMode) {
        // Sessions track their queue position via `queuePlayback` —
        // both song and YouTube variants carry the flag, so the next
        // session can replace the current entry in the history stack
        // regardless of kind. Direct launches leave the flag false.
        const replace = session.queuePlayback;
        await navigate('/playback', { replace, state: session });
        return;
      }

      await savePlaybackSession(session);
      await showPlaybackTarget(target);
    } catch (error) {
      target?.close();
      toast.error(
        `Could not start playback: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return { launch, reserveTarget, sessionMode };
}
