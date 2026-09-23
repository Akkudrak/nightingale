/**
 * Inline audio player used by both the recordings history dialog and the
 * leaderboards history view.
 *
 * The player renders a single `<audio>` element fed by `useRecordingUrl(id)`
 * so the same cross-transport URL resolution (`/api/recording/:id` on web,
 * `convertFileSrc` on Tauri) applies. Keeping it as a separate file means
 * the dialogs only worry about table/header chrome and can compose this
 * anywhere they need to surface playback.
 */

import { useRecordingUrl } from '@/features/recordings/hooks/use-recording-url';
import { Button } from '@/shared/components/ui/button';
import type { RecordingRecord } from '@/types/RecordingRecord';

type Props = {
  recording: RecordingRecord | null;
  onClose?: () => void;
  /** When true, render a close button at the right edge. */
  showCloseButton?: boolean;
};

export const RecordingPlayer = ({ recording, onClose, showCloseButton = true }: Props) => {
  const { url, loading, error } = useRecordingUrl(recording?.id ?? null);

  if (recording === null) {
    return null;
  }

  if (error !== null) {
    return (
      <p className="px-4 py-3 text-center text-xs text-muted-foreground">
        Could not load recording: {error}
      </p>
    );
  }

  return (
    <div className="flex items-center gap-3 border-t bg-muted/30 px-4 py-3 text-xs">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{recording.song_title || 'Untitled song'}</p>
        <p className="truncate text-muted-foreground">
          {recording.profile} · score {recording.score}
        </p>
      </div>
      {loading ? (
        <span className="text-muted-foreground">Loading audio…</span>
      ) : (
        <audio controls preload="metadata" src={url} className="h-8 max-w-full">
          <track kind="captions" />
        </audio>
      )}
      {showCloseButton && onClose ? (
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      ) : null}
    </div>
  );
};
