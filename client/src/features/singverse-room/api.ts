/**
 * The room API this server exposes to its screen (client/src-server/src/singverse).
 * Room state comes from SingVerse; `prep` says where each upcoming song's
 * `.nge` download stands, with the playable Nightingale song once ready.
 */

import { z } from 'zod';

import { songSchema } from '@/bridge/schemas';

const personSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatar: z.string().nullable(),
});

const itemSchema = z.object({
  id: z.string(),
  status: z.enum(['queued', 'playing', 'done', 'skipped']),
  position: z.number(),
  score: z.number().nullable(),
  started_at: z.string().nullable(),
  song: z.object({
    id: z.string(),
    title: z.string(),
    artist: z.string(),
    cover_url: z.string().nullable(),
    duration: z.number().nullable(),
  }),
  singer: personSchema,
});

const prepSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('queued') }),
  z.object({ status: z.literal('downloading'), received: z.number(), total: z.number() }),
  z.object({ status: z.literal('ready'), song: songSchema }),
  z.object({ status: z.literal('failed'), error: z.string() }),
]);

const roomStateSchema = z.object({
  room: z.object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    version: z.number(),
    closed: z.boolean(),
    join_url: z.string(),
    host: personSchema,
  }),
  current: itemSchema.nullable(),
  queue: z.array(itemSchema),
  recent: z.array(itemSchema),
  members: z.array(personSchema.extend({ online: z.boolean() })),
  prep: z.record(z.string(), prepSchema),
  join_qr_svg: z.string().nullable(),
});

export type RoomPerson = z.infer<typeof personSchema>;
export type RoomItem = z.infer<typeof itemSchema>;
export type Prep = z.infer<typeof prepSchema>;
export type RoomState = z.infer<typeof roomStateSchema>;

export class RoomRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request(method: string, url: string, body?: object): Promise<RoomState> {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new RoomRequestError(res.status, text === '' ? `HTTP ${res.status}` : text);
  }
  const data: unknown = await res.json();
  return roomStateSchema.parse(data);
}

export const loadRoom = (room: string) => request('GET', `/api/room/${room}/state`);

export const startItem = (room: string, item: string) =>
  request('POST', `/api/room/${room}/start`, { item });

export const finishItem = (room: string, item: string, score: number | null, skipped: boolean) =>
  request('POST', `/api/room/${room}/finish`, { item, score, skipped });
