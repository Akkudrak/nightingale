/**
 * Row-level preview button: toggles the global preview bar on/off for the
 * given song. Clicking a different row while a preview is active swaps to
 * the new song — `usePreviewControls.start` already handles this.
 *
 * `event.stopPropagation()` is important: the song row's own `onClick`
 * opens the song detail (or queues the song); we don't want the preview
 * tap to also fire that navigation.
 */

import { PauseIcon, PlayIcon } from 'lucide-react';
import type { MouseEvent } from 'react';

import { usePreviewControls } from '@/features/preview/hooks/use-preview-controls';
import { Button } from '@/shared/components/ui/button';
import type { Song } from '@/types/Song';

type Props = {
  song: Song;
};

export const PreviewRowButton = ({ song }: Props) => {
  const { isActive, start, stop } = usePreviewControls();
  const active = isActive(song);

  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    if (active) {
      stop();
    } else {
      start(song);
    }
  };

  return (
    <Button
      type="button"
      variant={active ? 'default' : 'ghost'}
      size="icon-sm"
      onClick={handleClick}
      aria-label={active ? 'Stop preview' : 'Preview song'}
      aria-pressed={active}
    >
      {active ? <PauseIcon /> : <PlayIcon />}
    </Button>
  );
};
