import { ListMusicIcon, Trash2Icon, YoutubeIcon } from 'lucide-react';

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

const QueueRowThumbnail = ({ entry }: { entry: PlaybackQueueEntry }) => {
  if (entry.kind === 'youtube') {
    return (
      <img
        src={entry.youtube.thumbnail_url}
        alt=""
        loading="lazy"
        className="size-10 shrink-0 rounded-md object-cover"
        width={40}
        height={40}
      />
    );
  }
  return (
    <AlbumArt song={entry.song} className="size-10 rounded-md" fallbackIconClassName="size-5" />
  );
};

const QueueRowTitle = ({ entry, isNextUp }: { entry: PlaybackQueueEntry; isNextUp: boolean }) => {
  if (entry.kind === 'youtube') {
    const title = entry.youtube.title !== '' ? entry.youtube.title : 'Untitled video';
    return (
      <>
        <YoutubeIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p className="truncate" title={title}>
          {title}
        </p>
        {isNextUp ? (
          <span className="shrink-0 text-xs font-medium text-primary"> · Next up</span>
        ) : null}
      </>
    );
  }
  const title = entry.song.title !== '' ? entry.song.title : 'Untitled';
  return (
    <>
      <p className="truncate" title={title}>
        {title}
      </p>
      {isNextUp ? (
        <span className="shrink-0 text-xs font-medium text-primary"> · Next up</span>
      ) : null}
    </>
  );
};

const QueueRowSubtitle = ({ entry }: { entry: PlaybackQueueEntry }) => {
  const isYoutube = entry.kind === 'youtube';
  const subtitle = isYoutube ? entry.youtube.channel_title : entry.song.artist;
  const fallback = isYoutube ? 'Unknown channel' : 'Unknown artist';
  const visible = subtitle !== '' ? subtitle : fallback;
  return (
    <p className="truncate text-xs text-muted-foreground">
      {visible}
      {entry.addedBy !== null ? ` · Added by ${entry.addedBy}` : ''}
    </p>
  );
};

const queueRowRemoveLabel = (entry: PlaybackQueueEntry): string => {
  if (entry.kind === 'youtube') {
    const title = entry.youtube.title !== '' ? entry.youtube.title : 'Untitled video';
    return `Remove ${title} from queue`;
  }
  const title = entry.song.title !== '' ? entry.song.title : 'Untitled';
  return `Remove ${title} from queue`;
};

const QueueRow = ({ entry, isNextUp, onRemove, isRemoving }: QueueRowProps) => (
  <li className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
    <QueueRowThumbnail entry={entry} />
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-1 text-sm font-medium">
        <QueueRowTitle entry={entry} isNextUp={isNextUp} />
      </div>
      <QueueRowSubtitle entry={entry} />
    </div>
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={() => onRemove(entry.id)}
      disabled={isRemoving}
      aria-label={queueRowRemoveLabel(entry)}
    >
      <Trash2Icon />
    </Button>
  </li>
);

const EmptyQueue = () => (
  <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center text-muted-foreground">
    <ListMusicIcon className="size-6" aria-hidden="true" />
    <p className="text-sm">The queue is empty.</p>
    <p className="text-xs">Add a song or a YouTube video to start the karaoke night.</p>
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
              ? 'No items queued yet.'
              : `${count} queued ${count === 1 ? 'item' : 'items'} for karaoke.`}
          </SheetDescription>
        </SheetHeader>
        <div className="themed-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <QueueBody />
        </div>
      </SheetContent>
    </Sheet>
  );
};
