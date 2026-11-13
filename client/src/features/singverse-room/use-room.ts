/**
 * The room screen's brain: polls the room, decides what is on stage, starts
 * the next singer after their introduction, skips songs that can't be loaded,
 * and reports each finished song to SingVerse.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Song } from '@/types/Song';

import {
  finishItem,
  loadRoom,
  type Prep,
  type RoomItem,
  RoomRequestError,
  type RoomState,
  startItem,
} from './api';
import type { RoomPlayback } from './room-playback-context';

const POLL_MS = 2000;
/** The next singer's card stays this long before their song starts. */
export const INTRO_SECONDS = 8;
/** A song that can't be loaded is shown this long, then skipped. */
const FAILED_SECONDS = 8;

export type Playing = { item: RoomItem; song: Song };
export type Problem = 'offline' | 'signedOut' | null;

type Apply = (state: RoomState) => void;
type Fail = (error: unknown) => void;

const problemOf = (error: unknown): Problem =>
  error instanceof RoomRequestError && error.status === 401 ? 'signedOut' : 'offline';

const isConflict = (error: unknown): boolean =>
  error instanceof RoomRequestError && error.status === 409;

export const prepOf = (state: RoomState | null, item: RoomItem | null): Prep | undefined =>
  state !== null && item !== null ? state.prep[item.id] : undefined;

const currentOf = (state: RoomState | null): RoomItem | null => state?.current ?? null;

const nextOf = (state: RoomState | null): RoomItem | null => state?.queue[0] ?? null;

/** The item whose song failed to load: on stage, or next when the stage is empty. */
function failedItem(state: RoomState | null): RoomItem | null {
  const current = currentOf(state);
  const candidate = current ?? nextOf(state);
  return prepOf(state, candidate)?.status === 'failed' ? candidate : null;
}

/** The next singer to introduce: nobody on stage and their song is ready. */
function introItem(state: RoomState | null, playing: Playing | null): RoomItem | null {
  if (playing !== null || currentOf(state) !== null) {
    return null;
  }
  const next = nextOf(state);
  return prepOf(state, next)?.status === 'ready' ? next : null;
}

/** The song on stage, ready to play, unless the screen already left it. */
function stagePlaying(state: RoomState | null, left: ReadonlySet<string>): Playing | null {
  const current = currentOf(state);
  const prep = prepOf(state, current);
  if (current === null || prep?.status !== 'ready' || left.has(current.id)) {
    return null;
  }
  return { item: current, song: prep.song };
}

function useRoomPolling(roomId: string) {
  const [state, setState] = useState<RoomState | null>(null);
  const [problem, setProblem] = useState<Problem>(null);

  const apply = useCallback<Apply>((next) => {
    setState(next);
    setProblem(null);
  }, []);
  const fail = useCallback<Fail>((error) => setProblem(problemOf(error)), []);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const next = await loadRoom(roomId);
        if (!stopped) {
          apply(next);
        }
      } catch (error) {
        if (!stopped) {
          fail(error);
        }
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [apply, fail, roomId]);

  return { state, problem, apply, fail };
}

/** Seconds left before `onDone` while `activeKey` is set (null when idle). */
function useIntroCountdown(activeKey: string | null, onDone: () => void): number | null {
  const [tick, setTick] = useState<{ key: string; left: number } | null>(null);
  const done = useRef(onDone);

  useEffect(() => {
    done.current = onDone;
  });

  useEffect(() => {
    if (activeKey === null) {
      return undefined;
    }
    let left = INTRO_SECONDS;
    const timer = setInterval(() => {
      left -= 1;
      setTick({ key: activeKey, left });
      if (left <= 0) {
        clearInterval(timer);
        done.current();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [activeKey]);

  if (activeKey === null) {
    return null;
  }
  return tick?.key === activeKey ? tick.left : INTRO_SECONDS;
}

/** Skips (after a moment) a song whose bundle could not be loaded. */
type RoomCalls = { roomId: string; apply: Apply; fail: Fail };

function useSkipFailed(
  { roomId, apply, fail }: RoomCalls,
  failed: RoomItem | null,
  onStage: boolean,
) {
  const failedId = failed?.id ?? null;

  useEffect(() => {
    if (failedId === null) {
      return undefined;
    }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          if (!onStage) {
            await startItem(roomId, failedId);
          }
          apply(await finishItem(roomId, failedId, null, true));
        } catch (error) {
          fail(error);
        }
      })();
    }, FAILED_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [apply, fail, failedId, onStage, roomId]);
}

/**
 * What playback reports back to the room for the song on stage. Once reported,
 * the song is held on screen (SingVerse no longer lists it on stage) until the
 * result screen exits.
 */
function useRoomPlayback(
  { roomId, apply, fail }: RoomCalls,
  playing: Playing | null,
  hold: (playing: Playing | null) => void,
  leave: (itemId: string) => void,
): RoomPlayback | null {
  const reported = useRef(new Set<string>());

  return useMemo<RoomPlayback | null>(() => {
    if (playing === null) {
      return null;
    }
    const itemId = playing.item.id;
    const finish = async (score: number | null, skipped: boolean) => {
      if (reported.current.has(itemId)) {
        return;
      }
      reported.current.add(itemId);
      try {
        apply(await finishItem(roomId, itemId, score, skipped));
      } catch (error) {
        // 409: already finished on SingVerse (skipped from a phone), nothing to save.
        if (!isConflict(error)) {
          fail(error);
        }
      }
    };
    return {
      singer: playing.item.singer.name,
      onFinished: (score) => {
        hold(playing);
        void finish(score, false);
      },
      onExit: () => {
        void finish(null, true);
        leave(itemId);
        hold(null);
      },
    };
  }, [apply, fail, hold, leave, playing, roomId]);
}

async function warmUpMicrophone() {
  // Ask for the microphone now, not in the middle of the first song.
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
  } catch {
    // Denied or no microphone: songs still play, scores stay at 0.
  }
}

export function useRoom(roomId: string) {
  const { state, problem, apply, fail } = useRoomPolling(roomId);
  const [armed, setArmed] = useState(false);
  // Songs this screen left (exited or finished) and the one whose result is showing.
  const [left, setLeft] = useState<ReadonlySet<string>>(() => new Set());
  const [held, setHeld] = useState<Playing | null>(null);
  const starting = useRef<string | null>(null);

  // SingVerse's "on stage" drives the screen; a song skipped from a phone just disappears.
  const playing = useMemo(
    () => (armed ? (held ?? stagePlaying(state, left)) : null),
    [armed, held, left, state],
  );

  const start = useCallback(
    async (item: RoomItem) => {
      if (starting.current === item.id) {
        return;
      }
      starting.current = item.id;
      try {
        apply(await startItem(roomId, item.id));
      } catch (error) {
        fail(error);
      } finally {
        starting.current = null;
      }
    },
    [apply, fail, roomId],
  );

  const intro = armed ? introItem(state, playing) : null;
  const countdown = useIntroCountdown(intro?.id ?? null, () => {
    if (intro !== null) {
      void start(intro);
    }
  });

  const failed = armed ? failedItem(state) : null;
  const calls = useMemo<RoomCalls>(() => ({ roomId, apply, fail }), [apply, fail, roomId]);
  useSkipFailed(calls, failed, failed !== null && failed.id === currentOf(state)?.id);

  const leave = useCallback((itemId: string) => setLeft((set) => new Set(set).add(itemId)), []);
  const roomPlayback = useRoomPlayback(calls, playing, setHeld, leave);

  const arm = useCallback(async () => {
    setArmed(true);
    await warmUpMicrophone();
  }, []);

  return {
    state,
    problem,
    armed,
    arm,
    playing,
    roomPlayback,
    countdown,
    startNow: intro === null ? undefined : () => void start(intro),
  };
}
