/**
 * The screen of a SingVerse karaoke room (TV or laptop). Phones queue songs on
 * SingVerse; this page shows the join QR and the queue, introduces each singer,
 * plays their song with Nightingale's own playback screen and pitch scoring,
 * and reports the score back (saved on the singer's SingVerse profile).
 */

import { useMemo } from 'react';
import { useParams } from 'react-router';

import { PlaybackInner } from '@/features/playback/playback-inner';
import { Button } from '@/shared/components/ui/button';
import { Progress } from '@/shared/components/ui/progress';
import { useConfig } from '@/shared/config/use-config';

import type { Prep, RoomItem, RoomState } from './api';
import { RoomPlaybackContext } from './room-playback-context';
import { roomStrings } from './strings';
import { type Problem, useRoom } from './use-room';

type T = ReturnType<typeof roomStrings>;

/** GPL-3.0: where this screen's source code lives (point it at the published fork). */
const SOURCE_URL = 'https://github.com/Akkudrak/nightingale';

/** The stage card's item: who sings now, or who is next. */
const stageItemOf = (state: RoomState | null): RoomItem | null =>
  state === null ? null : (state.current ?? state.queue.at(0) ?? null);

const prepFor = (state: RoomState | null, item: RoomItem | null): Prep | undefined =>
  state === null || item === null ? undefined : state.prep[item.id];

export function RoomPage() {
  const { roomId = '' } = useParams();
  const { data: config } = useConfig();
  const language = config?.language;
  const t = useMemo(() => roomStrings(language), [language]);
  const room = useRoom(roomId);

  if (room.playing !== null && room.roomPlayback !== null) {
    return (
      <RoomPlaybackContext.Provider value={room.roomPlayback}>
        <PlaybackInner
          key={room.playing.item.id}
          song={room.playing.song}
          config={config ?? null}
          queuePlayback={false}
          sessionPlayback={false}
        />
      </RoomPlaybackContext.Provider>
    );
  }

  return <Lobby t={t} room={room} />;
}

function Lobby({ t, room }: { t: T; room: ReturnType<typeof useRoom> }) {
  const { state } = room;
  const stageItem = stageItemOf(state);

  return (
    <div className="bg-background text-foreground fixed inset-0 overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-7xl flex-col gap-8 p-6 lg:flex-row lg:items-stretch lg:p-12">
        <JoinPanel t={t} state={state} />
        <section className="flex min-w-0 flex-1 flex-col gap-6">
          <Notices t={t} problem={room.problem} closed={state?.room.closed === true} />
          {room.armed ? (
            <Stage
              t={t}
              item={stageItem}
              prep={prepFor(state, stageItem)}
              countdown={room.countdown}
              onStartNow={room.startNow}
            />
          ) : (
            <StartGate t={t} onStart={() => void room.arm()} />
          )}
          {state !== null && <QueueList t={t} state={state} />}
          {state !== null && <RecentScores t={t} items={state.recent} />}
        </section>
      </div>
      <p className="text-muted-foreground pb-4 text-center text-xs">
        {t('credit')}{' '}
        <a className="underline" href={SOURCE_URL} target="_blank" rel="noreferrer">
          {SOURCE_URL.replace('https://', '')}
        </a>
      </p>
    </div>
  );
}

function JoinPanel({ t, state }: { t: T; state: RoomState | null }) {
  const qr = state?.join_qr_svg ?? null;

  return (
    <section className="flex flex-col items-center justify-center gap-5 text-center lg:w-[42%]">
      <h1 className="text-3xl font-extrabold tracking-tight lg:text-5xl">
        {state?.room.name ?? '…'}
      </h1>
      {qr !== null && (
        <img
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr)}`}
          alt={t('join')}
          className="w-56 rounded-2xl bg-white p-3 shadow-2xl lg:w-72"
        />
      )}
      <p className="text-muted-foreground text-lg">{t('join')}</p>
      {state !== null && (
        <div>
          <p className="text-muted-foreground text-xs tracking-widest uppercase">{t('code')}</p>
          <p className="font-mono text-5xl font-black tracking-[0.3em] lg:text-6xl">
            {state.room.code}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">{state.room.join_url}</p>
        </div>
      )}
    </section>
  );
}

function Notices({ t, problem, closed }: { t: T; problem: Problem; closed: boolean }) {
  return (
    <>
      {problem !== null && (
        <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-amber-300">
          {problem === 'signedOut' ? t('signedOut') : t('offline')}
        </p>
      )}
      {closed && <p className="rounded-xl border p-4">{t('closed')}</p>}
    </>
  );
}

function StartGate({ t, onStart }: { t: T; onStart: () => void }) {
  return (
    <div className="bg-card flex flex-1 flex-col items-center justify-center gap-4 rounded-3xl border p-10 text-center">
      <Button size="lg" className="h-14 rounded-full px-10 text-xl font-bold" onClick={onStart}>
        {t('start')}
      </Button>
      <p className="text-muted-foreground max-w-md">{t('startHint')}</p>
      <p className="text-muted-foreground max-w-md text-sm">{t('micHint')}</p>
    </div>
  );
}

function Cover({ url, big = false }: { url: string | null; big?: boolean }) {
  const size = big ? 'size-40 lg:size-56' : 'size-12';
  if (url === null) {
    return <span className={`${size} bg-muted shrink-0 rounded-xl`} />;
  }
  return <img src={url} alt="" className={`${size} shrink-0 rounded-xl object-cover`} />;
}

function QueueList({ t, state }: { t: T; state: RoomState }) {
  // The first waiting song is already on the stage card when nobody sings.
  const items = state.queue.slice(state.current === null ? 1 : 0, 8);
  if (items.length === 0) {
    return null;
  }

  return (
    <div>
      <h2 className="text-muted-foreground mb-2 text-sm font-semibold tracking-widest uppercase">
        {t('queue')}
      </h2>
      <ol className="space-y-2">
        {items.map((item) => (
          <li key={item.id} className="bg-card flex items-center gap-3 rounded-xl border p-3">
            <Cover url={item.song.cover_url} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{item.song.title}</p>
              <p className="text-muted-foreground truncate text-sm">{item.song.artist}</p>
            </div>
            <span className="truncate text-sm font-semibold">{item.singer.name}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function RecentScores({ t, items }: { t: T; items: RoomItem[] }) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div>
      <h2 className="text-muted-foreground mb-2 text-sm font-semibold tracking-widest uppercase">
        {t('scores')}
      </h2>
      <ul className="grid gap-2 sm:grid-cols-2">
        {items.slice(0, 6).map((item) => (
          <li
            key={item.id}
            className="flex items-center justify-between gap-3 rounded-xl border p-3"
          >
            <div className="min-w-0">
              <p className="truncate font-semibold">{item.singer.name}</p>
              <p className="text-muted-foreground truncate text-xs">{item.song.title}</p>
            </div>
            <span className="font-mono text-2xl font-black tabular-nums">
              {item.status === 'done' && item.score !== null ? item.score : t('skipped')}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const percentOf = (prep: Prep | undefined): number | null =>
  prep?.status === 'downloading' && prep.total > 0
    ? Math.round((prep.received / prep.total) * 100)
    : null;

function Downloading({ t, prep }: { t: T; prep: Prep | undefined }) {
  const percent = percentOf(prep);
  return (
    <div className="w-72 space-y-2">
      <p className="text-muted-foreground text-sm">
        {percent === null ? t('preparing') : t('downloading', { percent })}
      </p>
      <Progress value={percent ?? 5} />
    </div>
  );
}

function Countdown({
  t,
  countdown,
  onStartNow,
}: {
  t: T;
  countdown: number;
  onStartNow?: () => void;
}) {
  return (
    <div className="flex items-center gap-4">
      <p className="text-muted-foreground text-lg tabular-nums">
        {t('startsIn', { n: Math.max(0, countdown) })}
      </p>
      {onStartNow !== undefined && (
        <Button size="lg" className="rounded-full font-bold" onClick={onStartNow}>
          {t('startNow')}
        </Button>
      )}
    </div>
  );
}

function PrepStatus({
  t,
  prep,
  countdown,
  onStartNow,
}: {
  t: T;
  prep: Prep | undefined;
  countdown: number | null;
  onStartNow?: () => void;
}) {
  if (prep?.status === 'failed') {
    return <p className="text-destructive">{t('failed', { error: prep.error })}</p>;
  }
  if (prep?.status !== 'ready') {
    return <Downloading t={t} prep={prep} />;
  }
  return countdown === null ? null : (
    <Countdown t={t} countdown={countdown} onStartNow={onStartNow} />
  );
}

function Stage({
  t,
  item,
  prep,
  countdown,
  onStartNow,
}: {
  t: T;
  item: RoomItem | null;
  prep: Prep | undefined;
  countdown: number | null;
  onStartNow?: () => void;
}) {
  if (item === null) {
    return (
      <div className="bg-card flex flex-1 items-center justify-center rounded-3xl border p-10 text-center text-2xl font-semibold">
        {t('empty')}
      </div>
    );
  }

  return (
    <div className="bg-card relative flex flex-1 flex-col items-center justify-center gap-5 overflow-hidden rounded-3xl border p-8 text-center">
      {item.song.cover_url !== null && (
        <img
          src={item.song.cover_url}
          alt=""
          className="absolute inset-0 size-full scale-110 object-cover opacity-20 blur-2xl"
        />
      )}
      <div className="relative flex flex-col items-center gap-4">
        <p className="text-primary text-sm font-bold tracking-[0.3em] uppercase">
          {countdown === null ? t('upNext') : t('nowSinging')}
        </p>
        <p className="text-5xl font-black tracking-tight lg:text-7xl">{item.singer.name}</p>
        <Cover url={item.song.cover_url} big />
        <div>
          <p className="text-2xl font-bold lg:text-3xl">{item.song.title}</p>
          <p className="text-muted-foreground text-lg">{item.song.artist}</p>
        </div>
        <PrepStatus t={t} prep={prep} countdown={countdown} onStartNow={onStartNow} />
      </div>
    </div>
  );
}
