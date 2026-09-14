import { PauseIcon, PlayIcon, XIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/shared/components/ui/button';
import { cn } from '@/shared/utils/cn';
import type { Song } from '@/types/Song';

// Pre-analyzed songs expose both an instrumental and a vocal stem, so the
// preview can play them together at a lower guide-vocal level — this lets the
// guest recognize the melody without losing the backing track. Songs without
// stems fall back to the raw asset so every library entry is at least audible.
const GUIDE_VOCALS_VOLUME = 0.55;
const DRIFT_RESYNC_SECONDS = 0.2;

type PreviewSources = {
  instrumentalUrl: string | null;
  vocalsUrl: string | null;
  fallbackUrl: string | null;
};

const resolveSources = (song: Song | null): PreviewSources => {
  if (song === null) {
    return { instrumentalUrl: null, vocalsUrl: null, fallbackUrl: null };
  }
  if (song.is_analyzed && !song.no_stems) {
    return {
      instrumentalUrl: `/media/${song.file_hash}/instrumental`,
      vocalsUrl: `/media/${song.file_hash}/vocals`,
      fallbackUrl: null,
    };
  }
  return {
    instrumentalUrl: null,
    vocalsUrl: null,
    fallbackUrl: `/api/asset?path=${encodeURIComponent(song.path)}`,
  };
};

const syncVocalsToInstrumental = (
  instrumental: HTMLAudioElement,
  vocals: HTMLAudioElement | null,
  hasStems: boolean,
  vocalsBroken: boolean,
) => {
  if (vocals === null || !hasStems || vocalsBroken) {
    return;
  }
  if (Math.abs(vocals.currentTime - instrumental.currentTime) > DRIFT_RESYNC_SECONDS) {
    vocals.currentTime = instrumental.currentTime;
  }
};

type PreviewPlayback = {
  isPlaying: boolean;
  hasError: boolean;
  toggle: () => void;
  renderAudioElements: () => ReactNode;
};

const usePreviewPlayback = (
  song: Song | null,
  previewUrl: string | null,
  vocalsUrl: string | null,
  hasStems: boolean,
): PreviewPlayback => {
  const instrumentalRef = useRef<HTMLAudioElement>(null);
  const vocalsRef = useRef<HTMLAudioElement>(null);
  const vocalsBrokenRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [erroredSongHash, setErroredSongHash] = useState<string | null>(null);

  const currentHash = song?.file_hash ?? null;
  const hasError = erroredSongHash !== null && erroredSongHash === currentHash;

  // Keep the vocals element at a level that lets the backing track dominate
  // while the melody stays recognizable. Silenced entirely when stems are not
  // available or when the vocal file failed to load for this preview session.
  useEffect(() => {
    const vocals = vocalsRef.current;
    if (vocals === null) {
      return;
    }
    vocals.volume = hasStems && !vocalsBrokenRef.current ? GUIDE_VOCALS_VOLUME : 0;
  }, [hasStems]);

  // Reset both elements and start playback whenever the previewed song changes.
  // The row tap that opened the player counts as the user gesture for autoplay;
  // if the browser rejects it, the user can still hit the play button.
  useEffect(() => {
    const instrumental = instrumentalRef.current;
    const vocals = vocalsRef.current;
    if (song === null || previewUrl === null) {
      return undefined;
    }
    vocalsBrokenRef.current = false;
    if (instrumental !== null) {
      instrumental.pause();
      instrumental.currentTime = 0;
    }
    if (vocals !== null) {
      vocals.pause();
      vocals.currentTime = 0;
    }
    if (instrumental !== null) {
      void instrumental.play().catch(() => {
        setIsPlaying(false);
      });
    }
    if (vocals !== null && hasStems) {
      void vocals.play().catch(() => {
        setIsPlaying(false);
      });
    }
    return () => {
      instrumental?.pause();
      vocals?.pause();
    };
  }, [song, previewUrl, hasStems]);

  const handleEnded = useCallback(() => {
    setIsPlaying(false);
    const vocals = vocalsRef.current;
    if (vocals !== null && !vocals.paused) {
      vocals.pause();
    }
  }, []);

  const handleInstrumentalError = useCallback(() => {
    if (currentHash !== null) {
      setErroredSongHash(currentHash);
    }
    setIsPlaying(false);
  }, [currentHash]);

  const handleVocalsError = useCallback(() => {
    // The vocal stem may be missing even when the song claims it has stems
    // (e.g. the cache file was deleted between scans). Fall back to the
    // instrumental-only path for the rest of this preview session.
    vocalsBrokenRef.current = true;
    const vocals = vocalsRef.current;
    if (vocals !== null) {
      vocals.pause();
      vocals.volume = 0;
    }
  }, []);

  const handleSeeked = useCallback(() => {
    const instrumental = instrumentalRef.current;
    if (instrumental !== null) {
      syncVocalsToInstrumental(instrumental, vocalsRef.current, hasStems, vocalsBrokenRef.current);
    }
  }, [hasStems]);

  const handleInstrumentalPlay = useCallback(() => {
    setIsPlaying(true);
  }, []);

  const handleInstrumentalPause = useCallback(() => {
    setIsPlaying(false);
  }, []);

  const toggle = useCallback(() => {
    const instrumental = instrumentalRef.current;
    const vocals = vocalsRef.current;
    if (instrumental === null) {
      return;
    }
    if (instrumental.paused) {
      if (vocals !== null && hasStems && !vocalsBrokenRef.current) {
        syncVocalsToInstrumental(instrumental, vocals, hasStems, vocalsBrokenRef.current);
        void vocals.play().catch(() => {
          setIsPlaying(false);
        });
      }
      void instrumental.play().catch(() => {
        setIsPlaying(false);
      });
      return;
    }
    instrumental.pause();
    if (vocals !== null && !vocals.paused) {
      vocals.pause();
    }
  }, [hasStems]);

  const renderAudioElements = useCallback(
    () => (
      <>
        <audio
          ref={instrumentalRef}
          src={previewUrl ?? undefined}
          preload="metadata"
          onPlay={handleInstrumentalPlay}
          onPause={handleInstrumentalPause}
          onSeeked={handleSeeked}
          onError={handleInstrumentalError}
          onEnded={handleEnded}
          className="hidden"
        >
          <track kind="captions" />
        </audio>
        <audio
          ref={vocalsRef}
          src={vocalsUrl ?? undefined}
          preload="metadata"
          onError={handleVocalsError}
          onEnded={handleEnded}
          className="hidden"
        >
          <track kind="captions" />
        </audio>
      </>
    ),
    [
      previewUrl,
      vocalsUrl,
      handleInstrumentalPlay,
      handleInstrumentalPause,
      handleSeeked,
      handleInstrumentalError,
      handleVocalsError,
      handleEnded,
    ],
  );

  return { isPlaying, hasError, toggle, renderAudioElements };
};

type PreviewToggleButtonProps = {
  isPlaying: boolean;
  hasError: boolean;
  onToggle: () => void;
};

const PreviewToggleButton = ({ isPlaying, hasError, onToggle }: PreviewToggleButtonProps) => (
  <Button
    type="button"
    variant="default"
    size="icon-sm"
    onClick={onToggle}
    disabled={hasError}
    aria-label={isPlaying ? 'Pause preview' : 'Play preview'}
    aria-pressed={isPlaying}
  >
    {isPlaying ? <PauseIcon /> : <PlayIcon />}
  </Button>
);

type PreviewBodyProps = {
  song: Song;
  hasStems: boolean;
  hasError: boolean;
};

const PreviewBody = ({ song, hasStems, hasError }: PreviewBodyProps) => (
  <div className="min-w-0 flex-1">
    <p className="truncate text-sm font-medium" title={song.title}>
      {song.title !== '' ? song.title : 'Untitled'}
    </p>
    <p className="truncate text-xs text-muted-foreground">
      {song.artist !== '' ? song.artist : 'Unknown artist'}
      <span className="ml-2 text-[0.65rem] tracking-wide uppercase">
        {hasStems ? 'Preview · guide vocals' : 'Preview'}
      </span>
    </p>
    {hasError ? (
      <p className="text-xs text-destructive">Preview unavailable for this song.</p>
    ) : null}
  </div>
);

type PreviewPlayerProps = {
  song: Song | null;
  onClose: () => void;
};

export const PreviewPlayer = ({ song, onClose }: PreviewPlayerProps) => {
  const sources = useMemo(() => resolveSources(song), [song]);
  const { instrumentalUrl, vocalsUrl, fallbackUrl } = sources;
  const hasStems = instrumentalUrl !== null && vocalsUrl !== null;
  const previewUrl = instrumentalUrl ?? fallbackUrl;

  const { isPlaying, hasError, toggle, renderAudioElements } = usePreviewPlayback(
    song,
    previewUrl,
    vocalsUrl,
    hasStems,
  );

  if (song === null || previewUrl === null) {
    return null;
  }

  return (
    <section
      aria-label="Song preview"
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 border-t bg-background/95 px-4 py-2 shadow-lg backdrop-blur',
        'supports-backdrop-filter:bg-background/80',
      )}
    >
      {renderAudioElements()}
      <PreviewToggleButton isPlaying={isPlaying} hasError={hasError} onToggle={toggle} />
      <PreviewBody song={song} hasStems={hasStems} hasError={hasError} />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onClose}
        aria-label="Close preview"
      >
        <XIcon />
      </Button>
    </section>
  );
};
