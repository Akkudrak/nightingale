/**
 * History view for saved microphone recordings. Lists every recording
 * newest first with score + duration + when it was made, and embeds a
 * small `<audio>` player that the row can expand so the user can
 * replay the capture alongside (or instead of) the original song.
 *
 * `useDialogNav` is wired up so gamepad/remote users can navigate the
 * list with up/down and play the focused row with confirm; the same
 * keyboard shortcuts the leaderboards dialog uses apply here.
 */

import { MicIcon, TrashIcon } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

import { useDialog } from '@/features/menu/hooks/use-dialog';
import { useDialogNav } from '@/features/menu/hooks/use-dialog-nav';
import { RecordingPlayer } from '@/features/recordings/components/recording-player';
import { useDeleteRecording } from '@/features/recordings/mutations/use-recording-mutations';
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

const RING = 'ring-2 ring-primary';
const NO_FOCUS_RING = 'focus-visible:ring-0 focus-visible:border-transparent';

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '—';
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds) % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function RecordedAt({ recordedAt }: { recordedAt: bigint }) {
  const date = new Date(Number(recordedAt) * 1000);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return (
    <time
      className="block truncate text-[10px] text-muted-foreground"
      dateTime={date.toISOString()}
    >
      {date.toLocaleString()}
    </time>
  );
}

function RecordingTitle({ recording }: { recording: RecordingRecord }) {
  const title =
    recording.song_title.trim() === ''
      ? `Song ${recording.song_hash.slice(0, 8)}`
      : recording.song_title;
  const artist = recording.song_artist.trim() === '' ? 'Unknown artist' : recording.song_artist;
  return (
    <div className="min-w-0">
      <div className="truncate font-medium">{title}</div>
      <div className="truncate text-muted-foreground">{artist}</div>
    </div>
  );
}

export const RecordingsDialog = () => {
  const { mode, close } = useDialog();
  const { data: recordings, isLoading } = useRecordingsQuery();
  const deleteRecording = useDeleteRecording();
  const containerRef = useRef<HTMLDivElement>(null);
  const open = mode === 'recordings';

  // Active row id doubles as the "currently selected" pointer (for gamepad
  // navigation) and as the "open audio element" pointer (only one player
  // mounted at a time keeps the `<audio>` count down).
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeRecording = useMemo(
    () => recordings.find((r) => r.id === activeId) ?? null,
    [recordings, activeId],
  );

  const handleDelete = (id: string) => {
    if (activeId === id) {
      setActiveId(null);
    }
    deleteRecording.mutate(id);
  };

  const { focusedIndex, focusSegment } = useDialogNav({
    open,
    itemCount: Math.max(recordings.length, 1),
    containerRef,
    onBack: close,
  });

  const empty = !isLoading && recordings.length === 0;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100svh-2rem)] min-h-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
      >
        <div ref={containerRef} className="contents">
          <DialogHeader className="shrink-0 gap-1 border-b p-4 pr-10">
            <DialogTitle className="flex min-w-0 items-start gap-2 text-base">
              <MicIcon className="size-4 shrink-0 self-center text-primary" />
              <span className="min-w-0">
                <span className="block truncate">Recording history</span>
              </span>
            </DialogTitle>
            <DialogDescription>
              Every saved karaoke take, newest first. Pick a row to replay it.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overscroll-contain overflow-auto px-2 sm:px-4">
            {empty ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No recordings yet. Finish a song with the microphone on and tap “Save recording” to
                keep the take.
              </p>
            ) : (
              <Table className="table-fixed">
                <TableHeader className="sticky top-0 z-10 bg-background">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-9 w-8 px-1 text-xs">#</TableHead>
                    <TableHead className="h-9 text-xs">Song</TableHead>
                    <TableHead className="h-9 text-xs">Profile</TableHead>
                    <TableHead className="h-9 w-20 text-right text-xs">Score</TableHead>
                    <TableHead className="h-9 w-16 text-right text-xs">Length</TableHead>
                    <TableHead className="h-9 w-12 text-right text-xs" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recordings.map((recording, index) => {
                    const isActive = recording.id === activeId;
                    return (
                      <TableRow
                        key={recording.id}
                        onClick={() => setActiveId(recording.id)}
                        onMouseEnter={() => focusSegment(index)}
                        className={cn(
                          'cursor-pointer hover:bg-transparent',
                          isActive && 'bg-primary/5',
                          open && focusedIndex === index && RING,
                        )}
                      >
                        <TableCell className="px-1 py-2 text-xs tabular-nums">
                          {index + 1}
                        </TableCell>
                        <TableCell className="max-w-0 py-2 text-xs">
                          <RecordingTitle recording={recording} />
                          <RecordedAt recordedAt={recording.recorded_at} />
                        </TableCell>
                        <TableCell className="max-w-0 py-2 text-xs" title={recording.profile}>
                          <div className="truncate">{recording.profile}</div>
                        </TableCell>
                        <TableCell className="py-2 text-right text-xs font-medium tabular-nums">
                          {recording.score}
                        </TableCell>
                        <TableCell className="py-2 text-right text-xs tabular-nums">
                          {formatDuration(recording.duration_secs)}
                        </TableCell>
                        <TableCell className="py-2 text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label="Delete recording"
                            className="size-7 text-muted-foreground hover:text-destructive"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleDelete(recording.id);
                            }}
                          >
                            <TrashIcon className="size-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}

            <RecordingPlayer recording={activeRecording} onClose={() => setActiveId(null)} />
          </div>

          <DialogFooter className="shrink-0 border-t p-3">
            <Button
              variant="outline"
              onClick={close}
              onMouseEnter={() => focusSegment(recordings.length === 0 ? 0 : recordings.length - 1)}
              className={cn(
                NO_FOCUS_RING,
                open && focusedIndex === Math.max(recordings.length - 1, 0) && RING,
              )}
            >
              Close
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
};
