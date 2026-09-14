import { z } from 'zod';

import type { JukeboxState } from '@/types/JukeboxState';

import type { UnlistenFn } from './runtime';
import { listen } from './runtime';

const jukeboxStateSchema = z.object({
  controller: z.number().int().nullable(),
  current_song: z.string().nullable(),
  mic_owner: z.number().int().nullable(),
  paused: z.boolean(),
  pitch_hz: z.number().nullable(),
  position_ms: z.number().int().nonnegative(),
  rms: z.number().nullable(),
  score: z.number().int().nonnegative(),
  theme: z.string().nullable(),
});

const parseState = (value: unknown): JukeboxState => jukeboxStateSchema.parse(value);

export const onJukeboxChanged = async (
  callback: (state: JukeboxState) => void,
): Promise<UnlistenFn> =>
  await listen<unknown>('jukebox', ({ payload }) => callback(parseState(payload)));
