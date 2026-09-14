import { z } from 'zod';

import { invoke, listen, type UnlistenFn } from './runtime';
import { songSchema } from './schemas';

const playbackQueueEntrySchema = z.object({
  id: z.string(),
  song: songSchema,
  tempo: z.number(),
  keyOffset: z.number(),
  // Profile that queued the song. Older builds may omit it; treat that as
  // an unknown enqueuer rather than failing the whole queue.
  addedBy: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
});
const playbackQueueSchema = z.array(playbackQueueEntrySchema);

export type PlaybackQueueEntry = z.infer<typeof playbackQueueEntrySchema>;

const parseQueue = (value: unknown): PlaybackQueueEntry[] => playbackQueueSchema.parse(value);

export const loadPlaybackQueue = async (): Promise<PlaybackQueueEntry[]> =>
  parseQueue(await invoke('load_playback_queue'));

export const addPlaybackQueueEntry = async (
  fileHash: string,
  tempo: number,
  keyOffset: number,
  addedBy?: string | null,
): Promise<PlaybackQueueEntry[]> =>
  parseQueue(
    await invoke('add_playback_queue_entry', {
      fileHash,
      tempo,
      keyOffset,
      addedBy: addedBy ?? null,
    }),
  );

export const removePlaybackQueueEntry = async (id: string): Promise<PlaybackQueueEntry[]> =>
  parseQueue(await invoke('remove_playback_queue_entry', { id }));

export const clearPlaybackQueue = async (): Promise<PlaybackQueueEntry[]> =>
  parseQueue(await invoke('clear_playback_queue'));

export const onPlaybackQueueChanged = async (
  callback: (entries: PlaybackQueueEntry[]) => void,
): Promise<UnlistenFn> =>
  await listen<unknown>('playback-queue-changed', ({ payload }) => callback(parseQueue(payload)));
