import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import { toast } from 'sonner';

import {
  addPlaybackQueueEntry,
  clearPlaybackQueue,
  loadPlaybackQueue,
  onPlaybackQueueChanged,
  removePlaybackQueueEntry,
  type AddPlaybackQueueEntryInput,
  type PlaybackQueueEntry,
  type PlaybackQueueYoutubeEntry,
} from '@/bridge/playback-queue';
import type { PlaybackTarget } from '@/bridge/playback-session';
import { usePlaybackLauncher } from '@/features/playback/hooks/use-playback-launcher';
import {
  preparePlayback,
  type PreparePlaybackInput,
} from '@/features/playback/mutations/use-prepare-playback-mutation';
import { useCurrentProfile } from '@/features/profiles/hooks/use-current-profile';
import { PLAYBACK_QUEUE } from '@/shared/query-keys';
import type { Song } from '@/types/Song';

export function usePlaybackQueueQuery() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: PLAYBACK_QUEUE, queryFn: loadPlaybackQueue });

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void onPlaybackQueueChanged((entries) => {
      queryClient.setQueryData(PLAYBACK_QUEUE, entries);
    }).then((stop) => {
      if (cancelled) {
        stop();
        return undefined;
      }
      unlisten = stop;
      void queryClient.invalidateQueries({ queryKey: PLAYBACK_QUEUE });
      return undefined;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [queryClient]);

  return query;
}

/**
 * Input accepted by `useAddPlaybackQueueEntry`. Song entries reuse the
 * `PreparePlaybackInput` shape (tempo + key offset come from the song
 * details sidebar). YouTube entries take the YouTube target directly.
 */
export type AddQueueEntryInput =
  | (PreparePlaybackInput & { kind?: 'song' })
  | { kind: 'youtube'; youtube: PlaybackQueueYoutubeEntry['youtube'] };

export function useAddPlaybackQueueEntry() {
  const queryClient = useQueryClient();
  const currentProfile = useCurrentProfile();

  return useMutation<PlaybackQueueEntry[], Error, AddQueueEntryInput>({
    mutationFn: (variables) => {
      const addedBy = currentProfile ?? null;
      if (variables.kind === 'youtube') {
        const input: AddPlaybackQueueEntryInput = {
          kind: 'youtube',
          youtube: variables.youtube,
          addedBy,
        };
        return addPlaybackQueueEntry(input);
      }
      const input: AddPlaybackQueueEntryInput = {
        kind: 'song',
        fileHash: variables.song.file_hash,
        tempo: variables.tempo,
        keyOffset: variables.keyOffset,
        addedBy,
      };
      return addPlaybackQueueEntry(input);
    },
    onSuccess: (entries, variables) => {
      queryClient.setQueryData(PLAYBACK_QUEUE, entries);
      if (variables.kind === 'youtube') {
        const title =
          variables.youtube.title.trim() === '' ? 'Untitled video' : variables.youtube.title;
        toast.success(`Added “${title}” to the queue`);
      } else {
        const title = variables.song.title.trim() === '' ? 'Untitled' : variables.song.title;
        toast.success(`Added “${title}” to the queue`);
      }
    },
    onError: (error: Error) => toast.error(`Could not add to queue: ${error.message}`),
  });
}

export function useRemovePlaybackQueueEntry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: removePlaybackQueueEntry,
    onSuccess: (entries) => queryClient.setQueryData(PLAYBACK_QUEUE, entries),
    onError: (error: Error) => toast.error(`Could not remove song from queue: ${error.message}`),
  });
}

export function useClearPlaybackQueue() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: clearPlaybackQueue,
    onSuccess: (entries) => queryClient.setQueryData(PLAYBACK_QUEUE, entries),
    onError: (error: Error) => toast.error(`Could not clear queue: ${error.message}`),
  });
}

type StartSongInput = {
  entry: PlaybackQueueEntry;
  target: PlaybackTarget;
};

type StartSongResult = {
  id: string;
  song: Song;
  entries: PlaybackQueueEntry[];
  target: PlaybackTarget;
};

type StartYoutubeResult = {
  id: string;
  youtube: PlaybackQueueYoutubeEntry['youtube'];
  entries: PlaybackQueueEntry[];
  target: PlaybackTarget;
};

/**
 * Pops the front of the queue and launches it into the karaoke visor.
 * Branches on the entry's kind:
 *
 * - **Song** — runs the audio through `preparePlayback` so the user's
 *   tempo / key shifts are baked in, then removes the entry and
 *   launches a `{ kind: 'song', queuePlayback: true }` session.
 * - **YouTube** — skips `preparePlayback` (no audio engine), removes
 *   the entry, and launches a `{ kind: 'youtube', queuePlayback: true
 *   }` session. The karaoke visor uses `queuePlayback` to render the
 *   Skip button and the end-of-video Next overlay.
 */
export function useStartNextPlaybackQueueSong(entries: PlaybackQueueEntry[]) {
  const queryClient = useQueryClient();
  const { launch, reserveTarget } = usePlaybackLauncher();
  const { mutate, isLoading } = useMutation<
    StartSongResult | StartYoutubeResult,
    Error,
    StartSongInput
  >({
    mutationFn: async ({ entry, target }) => {
      const nextEntries = await removePlaybackQueueEntry(entry.id);
      if (entry.kind === 'youtube') {
        return {
          id: entry.id,
          youtube: entry.youtube,
          entries: nextEntries,
          target,
        };
      }
      const song = await preparePlayback({
        song: entry.song,
        tempo: entry.tempo,
        keyOffset: entry.keyOffset,
      });
      return { id: entry.id, song, entries: nextEntries, target };
    },
    onSuccess: (result, { target }) => {
      queryClient.setQueryData(PLAYBACK_QUEUE, result.entries);
      if ('song' in result) {
        void launch(
          {
            kind: 'song',
            song: result.song,
            queuePlayback: true,
            playbackId: result.id,
          },
          target,
        );
        return;
      }
      void launch(
        {
          kind: 'youtube',
          youtube: result.youtube,
          queuePlayback: true,
          playbackId: result.id,
        },
        target,
      );
    },
    onError: (error: Error, { target }) => {
      target?.close();
      toast.error(`Could not start queued playback: ${error.message}`);
    },
  });

  const playNext = useCallback(() => {
    if (entries.length === 0 || isLoading) {
      return;
    }
    const target = reserveTarget();
    if (target === undefined) {
      return;
    }
    mutate({ entry: entries[0], target });
  }, [entries, isLoading, mutate, reserveTarget]);

  return { playNext, isPreparing: isLoading };
}
