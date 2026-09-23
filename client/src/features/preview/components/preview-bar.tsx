/**
 * Global fixed-bottom preview player. Mounted once in `MenuLayout` so every
 * page can hand off to it without duplicating the audio element graph.
 */

import { PauseIcon, PlayIcon, XIcon } from 'lucide-react';

import { Button } from '@/shared/components/ui/button';
import { cn } from '@/shared/utils/cn';

import { usePreviewControls } from '../hooks/use-preview-controls';
import { usePreviewPlayback } from '../hooks/use-preview-playback';

const PreviewBody = ({ hasStems, hasError }: { hasStems: boolean; hasError: boolean }) => {
  const { activeSong } = usePreviewControls();
  if (activeSong === null) {
    return null;
  }
  return (
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-medium" title={activeSong.title}>
        {activeSong.title !== '' ? activeSong.title : 'Untitled'}
      </p>
      <p className="truncate text-xs text-muted-foreground">
        {activeSong.artist !== '' ? activeSong.artist : 'Unknown artist'}
        <span className="ml-2 text-[0.65rem] tracking-wide uppercase">
          {hasStems ? 'Preview · guide vocals' : 'Preview'}
        </span>
      </p>
      {hasError ? (
        <p className="text-xs text-destructive">Preview unavailable for this song.</p>
      ) : null}
    </div>
  );
};

export const PreviewBar = () => {
  const { activeSong, stop } = usePreviewControls();
  const { isPlaying, hasError, toggle, renderAudioElements } = usePreviewPlayback(activeSong);

  if (activeSong === null) {
    return null;
  }

  const hasStems = activeSong.isAnalyzed && !activeSong.noStems;

  return (
    <section
      aria-label="Song preview"
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 border-t bg-background/95 px-4 py-2 shadow-lg backdrop-blur',
        'supports-backdrop-filter:bg-background/80',
      )}
    >
      {renderAudioElements()}
      <Button
        type="button"
        variant="default"
        size="icon-sm"
        onClick={toggle}
        disabled={hasError}
        aria-label={isPlaying ? 'Pause preview' : 'Play preview'}
        aria-pressed={isPlaying}
      >
        {isPlaying ? <PauseIcon /> : <PlayIcon />}
      </Button>
      <PreviewBody hasStems={hasStems} hasError={hasError} />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={stop}
        aria-label="Close preview"
      >
        <XIcon />
      </Button>
    </section>
  );
};
