import { MusicIcon } from 'lucide-react';

import { convertFileSrc } from '@/bridge/media';
import { cn } from '@/shared/utils/cn';

import type { NowPlaying } from '../hooks/use-now-playing';

const formatLabel = (text: string | null, fallback: string): string => {
  if (text === null) {
    return fallback;
  }
  const trimmed = text.trim();
  return trimmed === '' ? fallback : trimmed;
};

export const NowPlayingHeader = ({ hash, title, artist, albumArtPath }: NowPlaying) => {
  const isPlaying = hash !== null;
  const displayTitle = formatLabel(title, 'Nothing playing');
  const displayArtist = formatLabel(artist, 'Pick a song to start the queue');

  return (
    <header
      className={cn(
        'flex items-center gap-3 border-b bg-background/95 px-4 py-2 backdrop-blur supports-backdrop-filter:bg-background/60',
      )}
    >
      <output
        aria-live="polite"
        className="contents"
        aria-label={
          isPlaying ? `Now playing: ${displayTitle} by ${displayArtist}` : 'No song playing'
        }
      >
        <div className="relative size-10 shrink-0 overflow-hidden rounded-md bg-muted text-muted-foreground">
          {isPlaying && albumArtPath !== null && albumArtPath !== '' ? (
            <img
              src={convertFileSrc(albumArtPath)}
              alt=""
              className="size-full object-cover"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <MusicIcon className="absolute inset-0 m-auto size-5" aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{displayTitle}</p>
          <p className="truncate text-xs text-muted-foreground">{displayArtist}</p>
        </div>
        {isPlaying ? (
          <span
            className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[0.65rem] font-medium tracking-wide text-emerald-600 uppercase dark:text-emerald-300"
            aria-label="Live: a song is currently playing"
          >
            <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
            Live
          </span>
        ) : null}
      </output>
    </header>
  );
};
