import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { onJukeboxChanged } from '@/bridge/jukebox';
import { loadSongsByHashes } from '@/bridge/songs';
import type { JukeboxState } from '@/types/JukeboxState';
import type { Song } from '@/types/Song';

const JUKBOX_STATE_KEY: readonly unknown[] = ['guest', 'jukebox-state'];

const EMPTY_STATE: JukeboxState = {
  controller: null,
  current_song: null,
  mic_owner: null,
  paused: true,
  pitch_hz: null,
  position_ms: 0,
  rms: null,
  score: 0,
  theme: null,
};

export const useJukeboxStateQuery = () =>
  useQuery<JukeboxState, Error>({
    queryKey: JUKBOX_STATE_KEY,
    queryFn: () => EMPTY_STATE,
    staleTime: Infinity,
    cacheTime: Infinity,
    initialData: EMPTY_STATE,
  });

export const useSubscribeJukebox = (): void => {
  const queryClient = useQueryClient();
  useEffect(() => {
    const lifecycle = { cancelled: false };
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const stop = await onJukeboxChanged((state) => {
          queryClient.setQueryData(JUKBOX_STATE_KEY, state);
        });
        if (lifecycle.cancelled) {
          stop();
          return;
        }
        unlisten = stop;
      } catch {
        // WS connection issues are reported by the bridge on next attempt.
      }
    })();
    return () => {
      lifecycle.cancelled = true;
      unlisten?.();
    };
  }, [queryClient]);
};

export const useNowPlayingSong = (hash: string | null) =>
  useQuery<Song | null>({
    queryKey: ['guest', 'now-playing-song', hash],
    enabled: hash !== null,
    queryFn: async (): Promise<Song | null> => {
      if (hash === null) {
        return null;
      }
      const rows = await loadSongsByHashes([hash]);
      return rows[0] ?? null;
    },
    staleTime: 30_000,
  });

export type NowPlaying = {
  hash: string | null;
  title: string | null;
  artist: string | null;
  albumArtPath: string | null;
  isPaused: boolean;
};

export const useNowPlaying = (): NowPlaying => {
  const { data: state } = useJukeboxStateQuery();
  const hash = state.current_song;
  const { data: song } = useNowPlayingSong(hash);
  return {
    hash,
    title: song?.title ?? null,
    artist: song?.artist ?? null,
    albumArtPath: song?.album_art_path ?? null,
    isPaused: state.paused,
  };
};
