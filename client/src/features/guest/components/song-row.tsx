import {
  ListPlusIcon,
  PauseIcon,
  PlayIcon,
  MusicIcon,
  StarIcon,
  ScrollTextIcon,
} from 'lucide-react';

import { AlbumArt } from '@/features/library/components/song-list/shared/album-art';
import { useAddPlaybackQueueEntry } from '@/features/playback-queue/use-playback-queue';
import { useToggleFavorite } from '@/features/profiles/mutations/use-favorite-mutations';
import { Stars } from '@/shared/components/shared/stars';
import { Button } from '@/shared/components/ui/button';
import { cn } from '@/shared/utils/cn';
import type { Song } from '@/types/Song';

const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '–:––';
  }
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${minutes}:${remaining.toString().padStart(2, '0')}`;
};

type FavoriteToggleButtonProps = {
  title: string;
  isFavorite: boolean;
  onToggle: () => void;
};

const FavoriteToggleButton = ({ title, isFavorite, onToggle }: FavoriteToggleButtonProps) => (
  <Button
    type="button"
    variant="ghost"
    size="icon-sm"
    onClick={onToggle}
    aria-pressed={isFavorite}
    aria-label={isFavorite ? `Remove ${title} from favorites` : `Add ${title} to favorites`}
    className={cn(
      'shrink-0 text-muted-foreground hover:text-foreground',
      isFavorite && 'text-primary hover:text-primary',
    )}
  >
    <StarIcon
      className={cn('transition-colors', isFavorite && 'fill-current')}
      aria-hidden="true"
    />
  </Button>
);

type SongRowProps = {
  song: Song;
  isPreviewing: boolean;
  isFavorite: boolean;
  bestScore: number | undefined;
  onPreview: (song: Song) => void;
  onPreviewStop: () => void;
  onLyrics: (song: Song) => void;
};

export const SongRow = ({
  song,
  isPreviewing,
  isFavorite,
  bestScore,
  onPreview,
  onPreviewStop,
  onLyrics,
}: SongRowProps) => {
  const { mutate: addToQueue, isPending } = useAddPlaybackQueueEntry();
  const { mutate: toggleFavorite } = useToggleFavorite();

  const handlePreviewToggle = () => {
    if (isPreviewing) {
      onPreviewStop();
    } else {
      onPreview(song);
    }
  };

  const handleQueue = () => {
    addToQueue({ song, tempo: 1, keyOffset: 0 });
  };

  const handleToggleFavorite = () => {
    toggleFavorite({ songHash: song.file_hash, next: !isFavorite });
  };

  const handleLyrics = () => {
    onLyrics(song);
  };

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border bg-card/40 px-3 py-2.5 transition-colors sm:gap-3.5 sm:px-3.5',
        'hover:bg-card/70 focus-within:bg-card/70',
      )}
    >
      <FavoriteToggleButton
        title={song.title}
        isFavorite={isFavorite}
        onToggle={handleToggleFavorite}
      />
      <div className="size-12 shrink-0 overflow-hidden rounded-md bg-muted text-muted-foreground">
        <AlbumArt song={song} className="size-12 rounded-md" fallbackIconClassName="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={song.title}>
          {song.title !== '' ? song.title : 'Untitled'}
        </p>
        <div className="mt-0.5 flex min-w-0 items-center gap-2">
          <p className="truncate text-xs text-muted-foreground" title={song.artist}>
            {song.artist !== '' ? song.artist : 'Unknown artist'}
            {song.album !== '' ? ` · ${song.album}` : ''}
          </p>
          {bestScore !== undefined ? (
            <Stars score={bestScore} size="sm" className="shrink-0" />
          ) : null}
        </div>
      </div>
      <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">
        {formatDuration(song.duration_secs)}
      </span>
      <div className="flex shrink-0 items-center gap-1 rounded-md bg-muted/40 p-0.5">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          onClick={handlePreviewToggle}
          aria-label={isPreviewing ? `Stop preview of ${song.title}` : `Preview ${song.title}`}
          aria-pressed={isPreviewing}
          className="bg-background"
        >
          {isPreviewing ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={handleLyrics}
          aria-label={`Show lyrics for ${song.title}`}
          className="text-muted-foreground hover:text-foreground"
        >
          <ScrollTextIcon aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="default"
          size="icon-sm"
          onClick={handleQueue}
          disabled={isPending}
          aria-label={`Add ${song.title} to the karaoke queue`}
        >
          {isPending ? <MusicIcon className="animate-pulse" /> : <ListPlusIcon />}
        </Button>
      </div>
    </div>
  );
};
