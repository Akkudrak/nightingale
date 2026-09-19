/**
 * Classic playback reads the song from location state. Session playback loads
 * shared state when the same route has the `session` query flag.
 */

import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router';

import {
  isSessionPlayback,
  loadPlaybackSession,
  onPlaybackSessionChanged,
  type PlaybackSession,
} from '@/bridge/playback-session';
import { playbackLocationStateSchema } from '@/bridge/schemas';
import {
  usePlaybackQueueQuery,
  useStartNextPlaybackQueueSong,
} from '@/features/playback-queue/use-playback-queue';
import { useConfig } from '@/shared/config/use-config';

import { YouTubePlayback } from './components/youtube-playback';
import { PlaybackInner } from './playback-inner';

/**
 * YouTube session renderer. Lives in its own component so the queue
 * hooks only run for the YouTube branch — the song branch stays on
 * its existing `usePlaybackResult` / `ResultDialog` flow without
 * subscribing to `playback-queue-changed` events.
 */
function YouTubeSessionView({
  session,
}: {
  session: Extract<PlaybackSession, { kind: 'youtube' }>;
}) {
  const { data: queueEntries = [] } = usePlaybackQueueQuery();
  const { playNext } = useStartNextPlaybackQueueSong(queueEntries);
  return (
    <YouTubePlayback
      key={session.playbackId ?? session.youtube.video_id}
      youtube={session.youtube}
      queuePlayback={session.queuePlayback}
      onNext={playNext}
    />
  );
}

function PlaybackSessionView({
  session,
  sessionPlayback,
}: {
  session: PlaybackSession;
  sessionPlayback: boolean;
}) {
  // `useConfig` must run unconditionally (Rules of Hooks). The branch
  // sits below — only `PlaybackInner` actually consumes `config`.
  const { data: config } = useConfig();

  if (session.kind === 'youtube') {
    // YouTube sessions never enter the queue pipeline; they go straight
    // into the karaoke visor with the embedded iframe. The session
    // carries a `queuePlayback` flag that the visor reads to decide
    // whether to surface Skip / Next-video affordances.
    return <YouTubeSessionView session={session} />;
  }

  return (
    <PlaybackInner
      key={session.playbackId ?? session.song.file_hash}
      song={session.song}
      config={config ?? null}
      queuePlayback={session.queuePlayback}
      sessionPlayback={sessionPlayback}
    />
  );
}

export const Playback = () => {
  const location = useLocation();
  if (isSessionPlayback()) {
    return <SessionPlayback />;
  }
  const state: unknown = location.state;
  const parsedState = playbackLocationStateSchema.safeParse(state);

  if (!parsedState.success) {
    return <Navigate to="/" replace />;
  }

  if (parsedState.data.kind === 'youtube') {
    const { youtube, queuePlayback = false, playbackId } = parsedState.data;
    return (
      <PlaybackSessionView
        session={{ kind: 'youtube', youtube, queuePlayback, playbackId }}
        sessionPlayback={false}
      />
    );
  }

  const { song, queuePlayback = false, playbackId } = parsedState.data;
  return (
    <PlaybackSessionView
      session={{ kind: 'song', song, queuePlayback, playbackId }}
      sessionPlayback={false}
    />
  );
};

const SessionPlayback = () => {
  const [session, setSession] = useState<PlaybackSession | null>();

  useEffect(() => {
    const lifecycle = { cancelled: false };
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const stop = await onPlaybackSessionChanged(setSession);
        if (lifecycle.cancelled) {
          stop();
          return;
        }
        unlisten = stop;
        setSession(await loadPlaybackSession());
      } catch {
        setSession(null);
      }
    })();

    return () => {
      lifecycle.cancelled = true;
      unlisten?.();
    };
  }, []);

  if (session === undefined) {
    return null;
  }
  if (session === null) {
    return <Navigate to="/" replace />;
  }
  return <PlaybackSessionView session={session} sessionPlayback />;
};
