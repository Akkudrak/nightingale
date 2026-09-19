import { z } from 'zod';

import { invoke, listen, type UnlistenFn } from './runtime';
import { songSchema, youtubeTargetSchema } from './schemas';

/**
 * Tagged union mirroring `PlaybackQueueEntry` in
 * `app-core/src/playback_queue.rs`. The `kind` discriminator is the
 * union key. Both variants carry a server-assigned `id` and an optional
 * `addedBy` profile. Song entries additionally carry `tempo` /
 * `keyOffset` so the playback pipeline can shift audio before launch;
 * YouTube entries skip the audio engine entirely and just hand the
 * target to the karaoke visor.
 */
const playbackQueueEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('song'),
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
  }),
  z.object({
    kind: z.literal('youtube'),
    id: z.string(),
    youtube: youtubeTargetSchema,
    addedBy: z
      .string()
      .nullish()
      .transform((value) => value ?? null),
  }),
]);
const playbackQueueSchema = z.array(playbackQueueEntrySchema);

export type PlaybackQueueEntry = z.infer<typeof playbackQueueEntrySchema>;
export type PlaybackQueueSongEntry = Extract<PlaybackQueueEntry, { kind: 'song' }>;
export type PlaybackQueueYoutubeEntry = Extract<PlaybackQueueEntry, { kind: 'youtube' }>;

/**
 * Tagged payload for `addPlaybackQueueEntry`. Mirrors the
 * `AddQueueEntryArgs` enum on the Rust side. The `addedBy` profile is
 * optional on both variants — the bridge wraps whatever the current
 * profile hook returns into the call.
 */
export type AddPlaybackQueueEntryInput =
  | {
      kind: 'song';
      fileHash: string;
      tempo: number;
      keyOffset: number;
      addedBy?: string | null;
    }
  | {
      kind: 'youtube';
      youtube: z.infer<typeof youtubeTargetSchema>;
      addedBy?: string | null;
    };

const parseQueue = (value: unknown): PlaybackQueueEntry[] => playbackQueueSchema.parse(value);

export const loadPlaybackQueue = async (): Promise<PlaybackQueueEntry[]> =>
  parseQueue(await invoke('load_playback_queue'));

export const addPlaybackQueueEntry = async (
  input: AddPlaybackQueueEntryInput,
): Promise<PlaybackQueueEntry[]> => {
  const { addedBy, ...rest } = input;
  return parseQueue(
    await invoke('add_playback_queue_entry', {
      ...rest,
      addedBy: addedBy ?? null,
    }),
  );
};

export const removePlaybackQueueEntry = async (id: string): Promise<PlaybackQueueEntry[]> =>
  parseQueue(await invoke('remove_playback_queue_entry', { id }));

export const clearPlaybackQueue = async (): Promise<PlaybackQueueEntry[]> =>
  parseQueue(await invoke('clear_playback_queue'));

export const onPlaybackQueueChanged = async (
  callback: (entries: PlaybackQueueEntry[]) => void,
): Promise<UnlistenFn> =>
  await listen<unknown>('playback-queue-changed', ({ payload }) => callback(parseQueue(payload)));
