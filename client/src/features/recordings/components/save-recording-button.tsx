/**
 * Inline action exposed inside the karaoke result dialog.
 *
 * - Hidden when the mic was off (no PCM to save).
 * - Disabled while the WAV is being encoded + uploaded.
 * - On success: invalidates the recordings cache so the history list
 *   picks up the new row without a page reload.
 *
 * The encode + upload path is wrapped in a try/catch that swallows the
 * toast; the `useSaveRecording` mutation already toasts on rejection,
 * but we surface a confirmation toast on success here because the
 * dialog disappears the moment the user clicks "Back" or "Next Song".
 */

import { CheckCircle2Icon, LoaderCircleIcon, MicIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { blobToBase64, encodeWav } from '@/features/microphone/lib/wav-encoder';
import type { RecordingTake } from '@/features/playback/hooks/use-playback-result';
import { useSaveRecording } from '@/features/recordings/mutations/use-recording-mutations';
import { Button } from '@/shared/components/ui/button';
import { cn } from '@/shared/utils/cn';
import type { Song } from '@/types/Song';

type Props = {
  song: Song;
  score: number;
  recording: RecordingTake | null;
  /** Unix seconds at which the take ended. Mirrored into the saved row so
   *  the history view can join `RecordingRecord` with `ScoreRecord` exactly. */
  playedAt: number;
};

export const SaveRecordingButton = ({ song, score, recording, playedAt }: Props) => {
  const save = useSaveRecording();
  const [saved, setSaved] = useState(false);
  const busy = save.isPending;

  if (recording === null) {
    return null;
  }

  if (saved) {
    return (
      <p className="flex w-full items-center justify-center gap-1.5 text-xs text-primary">
        <CheckCircle2Icon className="size-3.5" />
        Recording saved to history
      </p>
    );
  }

  const handleClick = (): void => {
    void (async () => {
      try {
        const blob = encodeWav(recording.samples, recording.sampleRate);
        const wavBase64 = await blobToBase64(blob);
        await save.mutateAsync({
          songHash: song.file_hash,
          songTitle: song.title,
          songArtist: song.artist,
          score,
          durationSecs: recording.durationSecs,
          sampleRate: recording.sampleRate,
          playedAt: playedAt > 0 ? playedAt : recording.playedAt,
          wavBase64,
        });
        setSaved(true);
        toast.success('Recording saved');
      } catch (error) {
        // useSaveRecording already toasts on `mutateAsync` rejection; the
        // catch exists so we don't bubble an unhandled rejection out of
        // the button's click handler.
        void error;
      }
    })();
  };

  return (
    <Button
      type="button"
      variant="outline"
      onClick={handleClick}
      disabled={busy}
      aria-busy={busy}
      className={cn('w-full gap-2')}
    >
      {busy ? (
        <>
          <LoaderCircleIcon className="size-3.5 animate-spin" />
          Saving recording…
        </>
      ) : (
        <>
          <MicIcon className="size-3.5" />
          Save recording
        </>
      )}
    </Button>
  );
};
