import { ListMusicIcon, Trash2Icon } from 'lucide-react';

import { type PlaybackQueueEntry } from '@/bridge/playback-queue';
import { AlbumArt } from '@/features/library/components/song-list/shared/album-art';
import {
  usePlaybackQueueQuery,
  useRemovePlaybackQueueEntry,
} from '@/features/playback-queue/use-playback-queue';
import { Button } from '@/shared/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/shared/components/ui/sheet';
import { cn } from '@/shared/utils/cn';

type QueueRowProps = {
  entry: PlaybackQueueEntry;
  isNextUp: boolean;
  onRemove: (id: string) => void;
  isRemoving: boolean;
};

const QueueRow = ({ entry, isNextUp, onRemove, isRemoving }: QueueRowProps) => (
  <li className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
    <AlbumArt song={entry.song} className="size-10 rounded-md" fallbackIconClassName="size-5" />
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center text-sm font-medium">
        <p className="truncate" title={entry.song.title}>
          {entry.song.title !== '' ? entry.song.title : 'Untitled'}
        </p>
        {isNextUp ? (
          <span className="shrink-0 text-xs font-medium text-primary"> · Next up</span>
        ) : null}
      </div>
      <p className="truncate text-xs text-muted-foreground">
        {entry.song.artist !== '' ? entry.song.artist : 'Unknown artist'}
        {entry.addedBy !== null ? ` · Added by ${entry.addedBy}` : ''}
      </p>
    </div>
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={() => onRemove(entry.id)}
      disabled={isRemoving}
      aria-label={`Remove ${entry.song.title} from queue`}
    >
      <Trash2Icon />
    </Button>
  </li>
);

const EmptyQueue = () => (
  <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center text-muted-foreground">
    <ListMusicIcon className="size-6" aria-hidden="true" />
    <p className="text-sm">The queue is empty.</p>
    <p className="text-xs">Add a song from the library to start the karaoke night.</p>
  </div>
);

const QueueBody = () => {
  const { data: entries = [], isLoading, isError } = usePlaybackQueueQuery();
  const { mutate: remove, isPending: removing } = useRemovePlaybackQueueEntry();

  if (isLoading) {
    return <p className="px-4 py-6 text-center text-xs text-muted-foreground">Loading queue…</p>;
  }

  if (isError) {
    return (
      <p className="px-4 py-6 text-center text-xs text-muted-foreground">
        Could not load the queue.
      </p>
    );
  }

  if (entries.length === 0) {
    return <EmptyQueue />;
  }

  return (
    <ol className="flex flex-col">
      {entries.map((entry, index) => (
        <QueueRow
          key={entry.id}
          entry={entry}
          isNextUp={index === 0}
          onRemove={remove}
          isRemoving={removing}
        />
      ))}
    </ol>
  );
};

type GuestQueueDrawerProps = {
  trigger: React.ReactNode;
};

export const GuestQueueDrawer = ({ trigger }: GuestQueueDrawerProps) => {
  const { data: entries = [] } = usePlaybackQueueQuery();
  const count = entries.length;

  return (
    <Sheet>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent
        side="right"
        showCloseButton
        className={cn('flex w-full max-w-md flex-col gap-0 p-0 sm:max-w-md', '[&>button]:top-3')}
      >
        <SheetHeader className="border-b">
          <SheetTitle>Playback Queue</SheetTitle>
          <SheetDescription>
            {count === 0
              ? 'No songs queued yet.'
              : `${count} ${count === 1 ? 'song' : 'songs'} queued for karaoke.`}
          </SheetDescription>
        </SheetHeader>
        <div className="themed-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <QueueBody />
        </div>
      </SheetContent>
    </Sheet>
  );
};
