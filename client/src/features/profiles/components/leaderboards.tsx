import { useQuery } from '@tanstack/react-query';
import { HistoryIcon, MicIcon, TrophyIcon } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';

import { loadSongsByHashes } from '@/bridge/songs';
import { useDialog, type DialogMode } from '@/features/menu/hooks/use-dialog';
import { useDialogNav } from '@/features/menu/hooks/use-dialog-nav';
import { useProfiles } from '@/features/profiles/queries/use-profiles';
import { RecordingPlayer } from '@/features/recordings/components/recording-player';
import { useRecordingsQuery } from '@/features/recordings/queries/use-recordings';
import { Button } from '@/shared/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table';
import { cn } from '@/shared/utils/cn';
import type { RecordingRecord } from '@/types/RecordingRecord';
import type { ScoreRecord } from '@/types/ScoreRecord';
import type { Song } from '@/types/Song';

const TOP_LIMIT = 10;
const HISTORY_LIMIT = 20;
const SONG_LEADERBOARD_LIMIT = 20;
const RING = 'ring-2 ring-primary';
const NO_FOCUS_RING = 'focus-visible:ring-0 focus-visible:border-transparent';
const EMPTY_SCORES: ScoreRecord[] = [];

function AchievedAt({ playedAt }: { playedAt: bigint }) {
  const date = new Date(Number(playedAt) * 1000);

  return Number.isNaN(date.getTime()) ? (
    '—'
  ) : (
    <time
      className="block truncate text-[10px] text-muted-foreground"
      dateTime={date.toISOString()}
    >
      {date.toLocaleString()}
    </time>
  );
}

function topScoreRecords(records: ScoreRecord[]): ScoreRecord[] {
  return records
    .map((record, index) => ({ record, index }))
    .toSorted((a, b) => b.record.score - a.record.score || a.index - b.index)
    .slice(0, TOP_LIMIT)
    .map(({ record }) => record);
}

/**
 * Newest-first slice for the history view. We don't dedup across profiles —
 * the user asked for the last 20 takes regardless of who sang them, so the
 * same player can show up several times in a row.
 */
function recentScoreRecords(records: ScoreRecord[]): ScoreRecord[] {
  return records.toSorted((a, b) => Number(b.played_at - a.played_at)).slice(0, HISTORY_LIMIT);
}

/**
 * All scoring attempts for one song, sorted by `score` descending then by
 * insertion order so equal scores land in chronological order. We do NOT
 * dedup by profile: the per-song leaderboard doubles as a "did I improve
 * over time?" view, so the same player shows up multiple times.
 */
function songAttempts(records: ScoreRecord[], songHash: string): ScoreRecord[] {
  return records
    .filter((record) => record.song_hash === songHash)
    .map((record, index) => ({ record, index }))
    .toSorted((a, b) => b.record.score - a.record.score || a.index - b.index)
    .slice(0, SONG_LEADERBOARD_LIMIT)
    .map(({ record }) => record);
}

type SongLeaderboardMode = Extract<DialogMode, { mode: 'song-leaderboard' }>;
type LeaderboardMode = 'leaderboards' | 'history' | SongLeaderboardMode;

function isLeaderboardMode(mode: DialogMode): mode is LeaderboardMode {
  return (
    mode === 'leaderboards' ||
    mode === 'history' ||
    (typeof mode === 'object' && mode !== null && mode.mode === 'song-leaderboard')
  );
}

function sameLeaderboardMode(left: LeaderboardMode, right: LeaderboardMode): boolean {
  if (left === 'leaderboards' || right === 'leaderboards') {
    return left === right;
  }
  if (left === 'history' || right === 'history') {
    return left === right;
  }

  return left.song.file_hash === right.song.file_hash;
}

function useRetainedLeaderboardMode(mode: DialogMode): LeaderboardMode {
  const [retainedMode, setRetainedMode] = useState<LeaderboardMode>('leaderboards');

  if (isLeaderboardMode(mode) && !sameLeaderboardMode(mode, retainedMode)) {
    setRetainedMode(mode);
  }

  return isLeaderboardMode(mode) ? mode : retainedMode;
}

/**
 * Bulk-look-up of song metadata for the hashes visible in the current
 * board. We keep this in a hook so the dialog body stays declarative and
 * the cyclomatic complexity of `LeaderboardsDialog` itself stays under
 * the lint budget.
 */
const useBoardSongs = (board: readonly ScoreRecord[], enabled: boolean) => {
  const sortedHashes = useMemo(() => {
    const hashes = board.map((record) => record.song_hash);
    return [...new Set(hashes)].toSorted();
  }, [board]);
  const query = useQuery({
    queryKey: ['leaderboard-songs', sortedHashes],
    queryFn: async () => {
      const songs = await loadSongsByHashes(sortedHashes);
      return new Map(songs.map((song) => [song.file_hash, song]));
    },
    enabled: enabled && sortedHashes.length > 0,
  });
  return { songs: query.data, songsLoading: query.isLoading };
};

/**
 * Indexes saved recordings by the same composite key `addScore` and
 * `saveRecording` write, so a score row can look up its take in O(1).
 * Older recordings without `played_at` simply never match and leave the
 * column showing `—`.
 */
const useRecordingMap = (recordings: readonly RecordingRecord[]) =>
  useMemo(() => {
    const map = new Map<string, RecordingRecord>();
    for (const recording of recordings) {
      map.set(
        `${recording.profile}::${recording.song_hash}::${recording.score}::${recording.played_at}`,
        recording,
      );
    }
    return map;
  }, [recordings]);

type LeaderboardSongNameProps = {
  song?: Song;
  loading: boolean;
  songHash: string;
};

function LeaderboardSongName({ song, loading, songHash }: LeaderboardSongNameProps) {
  if (song) {
    return (
      <div className="min-w-0">
        <div className="truncate font-medium">{song.title || songHash}</div>
        <div className="truncate text-muted-foreground">{song.artist || 'Unknown artist'}</div>
      </div>
    );
  }

  if (loading) {
    return 'Loading…';
  }

  return `Unknown song (${songHash.slice(0, 8)})`;
}

/**
 * Composite join key: a `ScoreRecord` and its `RecordingRecord` carry the
 * exact same `profile` + `song_hash` + `score` + `played_at` because
 * `usePlaybackResult` snapshots one timestamp and forwards it to both
 * writes. Older recordings that load without `played_at` (defaults to 0)
 * just won't match anything and fall back to the `—` indicator.
 */
const recordingJoinKey = (record: ScoreRecord): string =>
  `${record.profile}::${record.song_hash}::${record.score}::${record.played_at}`;

type RecordingIndicatorProps = {
  recording: RecordingRecord | null;
  onPlay: () => void;
};

/**
 * Clickable mic badge shown in the history table's Rec column. Plays the
 * matching take inline; if no recording is saved for this score shows the
 * neutral `—` placeholder so the column widths stay stable.
 */
const RecordingIndicator = ({ recording, onPlay }: RecordingIndicatorProps) => {
  if (recording === null) {
    return (
      <span aria-label="No recording saved" className="text-muted-foreground">
        —
      </span>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={`Play recording for ${recording.profile}`}
      className="size-7 text-primary hover:bg-primary/10"
      onClick={onPlay}
    >
      <MicIcon className="size-3.5" />
    </Button>
  );
};

type LeaderboardBoardProps = {
  empty: boolean;
  global: boolean;
  history: boolean;
  globalBoard: ScoreRecord[];
  songBoard: ScoreRecord[];
  recentBoard: ScoreRecord[];
  recordingMap: Map<string, RecordingRecord>;
  songs: Map<string, Song> | undefined;
  loading: boolean;
  onPlayRecording: (recording: RecordingRecord) => void;
};

const LeaderboardBoard = ({
  empty,
  global,
  history,
  globalBoard,
  songBoard,
  recentBoard,
  recordingMap,
  songs,
  loading,
  onPlayRecording,
}: LeaderboardBoardProps) => {
  if (empty) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No scores yet.</p>;
  }
  if (history) {
    return (
      <Table className="table-fixed">
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow className="hover:bg-transparent">
            <TableHead className="h-9 w-8 px-1 text-xs">#</TableHead>
            <TableHead className="h-9 text-xs">Date</TableHead>
            <TableHead className="h-9 text-xs">Song</TableHead>
            <TableHead className="h-9 w-[20%] text-xs">Profile</TableHead>
            <TableHead className="h-9 w-16 text-right text-xs">Score</TableHead>
            <TableHead className="h-9 w-12 text-right text-xs">Rec</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {recentBoard.map((record, index) => {
            const recording = recordingMap.get(recordingJoinKey(record)) ?? null;
            return (
              <TableRow
                key={`${record.song_hash}-${record.profile}-${record.score}-${record.played_at}`}
                className="hover:bg-transparent"
              >
                <TableCell className="px-1 py-2 text-xs tabular-nums">{index + 1}</TableCell>
                <TableCell className="py-2 text-xs">
                  <AchievedAt playedAt={record.played_at} />
                </TableCell>
                <TableCell className="max-w-0 py-2 text-xs">
                  <LeaderboardSongName
                    song={songs?.get(record.song_hash)}
                    loading={loading}
                    songHash={record.song_hash}
                  />
                </TableCell>
                <TableCell className="max-w-0 py-2 text-xs" title={record.profile}>
                  <div className="truncate">{record.profile}</div>
                </TableCell>
                <TableCell className="py-2 text-right text-xs font-medium tabular-nums">
                  {record.score}
                </TableCell>
                <TableCell className="py-2 text-right">
                  <RecordingIndicator
                    recording={recording}
                    onPlay={() => {
                      if (recording !== null) {
                        onPlayRecording(recording);
                      }
                    }}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    );
  }
  if (!global) {
    return (
      <Table className="table-fixed">
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow className="hover:bg-transparent">
            <TableHead className="h-9 w-8 px-1 text-xs">#</TableHead>
            <TableHead className="h-9 text-xs">Date</TableHead>
            <TableHead className="h-9 text-xs">Profile</TableHead>
            <TableHead className="h-9 w-16 text-right text-xs">Score</TableHead>
            <TableHead className="h-9 w-12 text-right text-xs">Rec</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {songBoard.map((record, index) => {
            const recording = recordingMap.get(recordingJoinKey(record)) ?? null;
            return (
              <TableRow
                key={`${record.song_hash}-${record.profile}-${record.score}-${record.played_at}`}
                className="hover:bg-transparent"
              >
                <TableCell className="px-1 py-2 text-xs tabular-nums">{index + 1}</TableCell>
                <TableCell className="py-2 text-xs">
                  <AchievedAt playedAt={record.played_at} />
                </TableCell>
                <TableCell className="max-w-0 py-2 text-xs" title={record.profile}>
                  <div className="truncate">{record.profile}</div>
                </TableCell>
                <TableCell className="py-2 text-right text-xs font-medium tabular-nums">
                  {record.score}
                </TableCell>
                <TableCell className="py-2 text-right">
                  <RecordingIndicator
                    recording={recording}
                    onPlay={() => {
                      if (recording !== null) {
                        onPlayRecording(recording);
                      }
                    }}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    );
  }

  return (
    <Table className="table-fixed">
      <TableHeader className="sticky top-0 z-10 bg-background">
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-9 w-8 px-1 text-xs">#</TableHead>
          <TableHead className="h-9 text-xs">Song</TableHead>
          <TableHead className="h-9 w-[28%] text-xs">Profile</TableHead>
          <TableHead className="h-9 w-16 text-right text-xs">Score</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {globalBoard.map((record, index) => (
          <TableRow
            key={`${record.song_hash}-${record.profile}-${record.score}-${record.played_at}`}
            className="hover:bg-transparent"
          >
            <TableCell className="px-1 py-2 text-xs tabular-nums">{index + 1}</TableCell>
            <TableCell className="max-w-0 py-2 text-xs">
              <LeaderboardSongName
                song={songs?.get(record.song_hash)}
                loading={loading}
                songHash={record.song_hash}
              />
            </TableCell>
            <TableCell className="max-w-0 py-2 text-xs" title={record.profile}>
              <div className="truncate">{record.profile}</div>
              <AchievedAt playedAt={record.played_at} />
            </TableCell>
            <TableCell className="py-2 text-right text-xs font-medium tabular-nums">
              {record.score}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

const LeaderboardHeading = ({
  historyOpen,
  headingTitle,
  showSongSubtitle,
  artist,
  compactDescription,
  descriptionText,
}: {
  historyOpen: boolean;
  headingTitle: string;
  showSongSubtitle: boolean;
  artist: string;
  compactDescription: boolean;
  descriptionText: string;
}) => (
  <DialogHeader className="shrink-0 gap-1 border-b p-4 pr-10">
    <DialogTitle className="flex min-w-0 items-start gap-2 text-base">
      {historyOpen ? (
        <HistoryIcon className="size-4 shrink-0 self-center text-primary" />
      ) : (
        <TrophyIcon className="size-4 shrink-0 self-center text-primary" />
      )}
      <span className="min-w-0">
        <span className="block truncate">{headingTitle}</span>
        {showSongSubtitle ? (
          <span className="block truncate text-xs font-normal text-muted-foreground">{artist}</span>
        ) : null}
      </span>
    </DialogTitle>
    <DialogDescription className={cn(compactDescription && 'sr-only')}>
      {descriptionText}
    </DialogDescription>
  </DialogHeader>
);

const displayedLeaderboard = (mode: LeaderboardMode) => ({
  global: mode === 'leaderboards',
  history: mode === 'history',
  songMode: typeof mode === 'object' ? mode : null,
});

const leaderboardSongCopy = (song: Song | undefined) => ({
  title: song?.title,
  artist: song === undefined || song.artist === '' ? 'Unknown artist' : song.artist,
});

const songLeaderboard = (scores: ScoreRecord[], songHash: string | undefined) =>
  typeof songHash === 'string' && songHash !== '' ? songAttempts(scores, songHash) : [];

type EmptyBoardArgs = {
  globalBoard: readonly ScoreRecord[];
  songBoard: readonly unknown[];
  recentBoard: readonly ScoreRecord[];
};

const isEmptyBoard = (
  global: boolean,
  historyOpen: boolean,
  { globalBoard, songBoard, recentBoard }: EmptyBoardArgs,
): boolean => {
  if (global) {
    return globalBoard.length === 0;
  }
  if (historyOpen) {
    return recentBoard.length === 0;
  }
  return songBoard.length === 0;
};

const pickHeadingTitle = (
  historyOpen: boolean,
  global: boolean,
  songTitle: string | undefined,
): string => {
  if (historyOpen) {
    return 'Recent plays';
  }
  if (global) {
    return 'Leaderboards';
  }
  return songTitle ?? '';
};

const pickDescriptionText = (historyOpen: boolean, global: boolean): string => {
  if (historyOpen) {
    return 'Latest scoring attempts across every profile, newest first.';
  }
  if (global) {
    return 'Top score records across every profile and song.';
  }
  return 'Every scoring attempt for this song — same profile can appear multiple times.';
};

/**
 * Aggregates everything the dialog needs to render: open-state, board
 * derivations, song-metadata lookup, recording index, and the inline
 * player's open/close controls. Lives in a hook so the JSX body stays
 * declarative and `LeaderboardsDialog` itself fits the lint budget.
 */
const useLeaderboardsState = () => {
  const { mode, close } = useDialog();
  const { data: profiles } = useProfiles();
  const { data: recordings } = useRecordingsQuery();
  const scores = profiles?.scores ?? EMPTY_SCORES;

  const displayedMode = useRetainedLeaderboardMode(mode);
  const open = isLeaderboardMode(mode);
  const {
    global: globalOpen,
    history: historyOpen,
    songMode,
  } = displayedLeaderboard(displayedMode);

  const globalBoard = useMemo(() => topScoreRecords(scores), [scores]);
  const recentBoard = useMemo(() => recentScoreRecords(scores), [scores]);
  const songHash = songMode?.song.file_hash;
  const songBoard = songLeaderboard(scores, songHash);

  // Songs to look up metadata for: union of (visible board hashes).
  const visibleBoard = historyOpen ? recentBoard : globalBoard;
  const { songs: leaderboardSongs, songsLoading } = useBoardSongs(
    visibleBoard,
    globalOpen || historyOpen,
  );

  const recordingMap = useRecordingMap(recordings);

  // Inline player open/close controls.
  const [playingRecording, setPlayingRecording] = useState<RecordingRecord | null>(null);
  const playRecording = useCallback<(recording: RecordingRecord) => void>((recording) => {
    setPlayingRecording(recording);
  }, []);
  const clearPlaying = useCallback<() => void>(() => {
    setPlayingRecording(null);
  }, []);

  const { title: songTitle, artist: songArtist } = leaderboardSongCopy(songMode?.song);

  return {
    open,
    close,
    globalOpen,
    historyOpen,
    globalBoard,
    songBoard,
    recentBoard,
    leaderboardSongs,
    songsLoading,
    recordingMap,
    playingRecording,
    playRecording,
    clearPlaying,
    songTitle,
    songArtist,
  };
};

export const LeaderboardsDialog = () => {
  const {
    open,
    close,
    globalOpen,
    historyOpen,
    globalBoard,
    songBoard,
    recentBoard,
    leaderboardSongs,
    songsLoading,
    recordingMap,
    playingRecording,
    playRecording,
    clearPlaying,
    songTitle,
    songArtist,
  } = useLeaderboardsState();
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { focusedIndex, focusSegment } = useDialogNav({
    open,
    itemCount: 1,
    containerRef,
    onBack: () => {
      clearPlaying();
      close();
    },
    onAction: (_segment, _slot, action) => {
      if (!action.up && !action.down) {
        return false;
      }
      scrollRef.current?.scrollBy({ top: action.down ? 48 : -48, behavior: 'smooth' });
      return true;
    },
  });

  const boardEmpty = isEmptyBoard(globalOpen, historyOpen, {
    globalBoard,
    songBoard,
    recentBoard,
  });

  // Derive header props here so the dialog body stays declarative.
  const headingTitle = pickHeadingTitle(historyOpen, globalOpen, songTitle);
  const showSongSubtitle = !globalOpen && !historyOpen;
  const compactDescription = !globalOpen && !historyOpen;
  const descriptionText = pickDescriptionText(historyOpen, globalOpen);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && close()}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          'flex max-h-[calc(100svh-2rem)] min-h-0 flex-col gap-0 overflow-hidden p-0',
          globalOpen || historyOpen ? 'sm:max-w-2xl' : 'sm:max-w-xl',
        )}
      >
        <div ref={containerRef} className="contents">
          <LeaderboardHeading
            historyOpen={historyOpen}
            headingTitle={headingTitle}
            showSongSubtitle={showSongSubtitle}
            artist={songArtist}
            compactDescription={compactDescription}
            descriptionText={descriptionText}
          />

          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overscroll-contain overflow-auto px-2 sm:px-4"
          >
            <LeaderboardBoard
              empty={boardEmpty}
              global={globalOpen}
              history={historyOpen}
              globalBoard={globalBoard}
              songBoard={songBoard}
              recentBoard={recentBoard}
              recordingMap={recordingMap}
              songs={leaderboardSongs}
              loading={songsLoading}
              onPlayRecording={playRecording}
            />
            {!globalOpen ? (
              <RecordingPlayer recording={playingRecording} onClose={clearPlaying} />
            ) : null}
          </div>

          <DialogFooter className="shrink-0 border-t p-3">
            <Button
              variant="outline"
              onClick={() => {
                clearPlaying();
                close();
              }}
              onMouseEnter={() => focusSegment(0)}
              className={cn(NO_FOCUS_RING, open && focusedIndex === 0 && RING)}
            >
              Close
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
};
