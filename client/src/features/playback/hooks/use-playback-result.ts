/**
 * Drives the end-of-song result dialog: watches transport.isFinished + the
 * skip-outro pending flag, persists the run's score to the active profile,
 * plays the success chime, and exposes the props the result dialog needs.
 *
 * Also drains the playback mic context's PCM buffer once and offers it
 * to the result dialog so the user can save the take alongside the
 * score.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import successSoundUrl from '@/assets/sounds/success.mp3';
import { addScore } from '@/bridge/profile';
import {
  usePlaybackQueueQuery,
  useStartNextPlaybackQueueSong,
} from '@/features/playback-queue/use-playback-queue';
import {
  usePlaybackMicActions,
  usePlaybackMicState,
  usePlaybackTranscriptActions,
  usePlaybackTranscriptState,
  usePlaybackTransportActions,
  usePlaybackTransportState,
} from '@/features/playback/providers';
import { useProfiles } from '@/features/profiles/queries/use-profiles';
import { useLatestRef } from '@/shared/hooks/use-latest-ref';
import { PROFILES } from '@/shared/query-keys';
import type { ScoreRecord } from '@/types/ScoreRecord';
import type { Song } from '@/types/Song';

export type RecordingTake = {
  samples: Float32Array;
  sampleRate: number;
  durationSecs: number;
  /**
   * Unix seconds at which the take ended. Snapshotted once when the song
   * finishes and reused for both `addScore` and `saveRecording` so the two
   * rows carry the exact same join key.
   */
  playedAt: number;
};

export type PlaybackResult = {
  open: boolean;
  score: number;
  scores: ScoreRecord[];
  activeProfile: string | null;
  nextPending: boolean;
  /** PCM captured during this session; `null` if the mic was off. */
  recording: RecordingTake | null;
  /** Unix seconds at which the score was recorded (matches `recording.playedAt`). */
  playedAt: number;
  onBack: () => void;
  onNext?: () => void;
};

export function usePlaybackResult(song: Song, queuePlayback: boolean): PlaybackResult {
  const fileHash = song.file_hash;
  const queryClient = useQueryClient();
  const { data: profileData, isLoading: profilesLoading } = useProfiles();
  const { data: entries = [] } = usePlaybackQueueQuery();
  const { isPreparing, playNext } = useStartNextPlaybackQueueSong(entries);

  const { isFinished } = usePlaybackTransportState();
  const { handleExit } = usePlaybackTransportActions();
  const { rawScore } = usePlaybackMicState();
  const { takeRecording } = usePlaybackMicActions();
  const { skipOutroPending } = usePlaybackTranscriptState();
  const { clearSkipOutroPending } = usePlaybackTranscriptActions();

  const [showResult, setShowResult] = useState(false);
  const [resultScore, setResultScore] = useState(0);
  const [playedAtSnapshot, setPlayedAt] = useState(0);
  const [recording, setRecording] = useState<RecordingTake | null>(null);

  const scoreRef = useLatestRef(rawScore);
  const takeRecordingRef = useLatestRef(takeRecording);
  const finishHandledRef = useRef(false);

  useEffect(() => {
    if (!isFinished && !skipOutroPending) {
      return;
    }

    if (profilesLoading) {
      return;
    }

    if (finishHandledRef.current) {
      return;
    }

    finishHandledRef.current = true;
    clearSkipOutroPending();

    const finalScore = scoreRef.current;
    const active = profileData?.active ?? null;
    const shouldShowResult = queuePlayback || finalScore > 0;

    // Snapshot the captured PCM once. We drain the recorder here
    // (not on dialog open) so the user can hit "Save recording" without
    // racing against an audio buffer that the next playback would reuse.
    const take = takeRecordingRef.current();
    // Take one timestamp that both `addScore` and `saveRecording` will reuse.
    // The two events happen back-to-back so they should agree exactly; if
    // we snapshotted independently they could drift by the round-trip time.
    const playedAt = Math.floor(Date.now() / 1000);
    setRecording(take ? { ...take, playedAt } : null);

    if (!shouldShowResult) {
      handleExit();
      return;
    }

    void (async () => {
      try {
        if (active !== null) {
          await addScore(fileHash, finalScore, playedAt);
          await queryClient.invalidateQueries({ queryKey: PROFILES });
        }
      } catch (e) {
        toast.error(`Could not save score: ${e instanceof Error ? e.message : String(e)}`);
      }
      setResultScore(finalScore);
      setPlayedAt(playedAt);
      setShowResult(true);
    })();
  }, [
    isFinished,
    skipOutroPending,
    fileHash,
    handleExit,
    profileData,
    profilesLoading,
    queryClient,
    clearSkipOutroPending,
    scoreRef,
    queuePlayback,
    takeRecordingRef,
  ]);

  useEffect(() => {
    if (!showResult) {
      return undefined;
    }

    const audioEl = new Audio(successSoundUrl);
    void audioEl.play().catch(() => {});

    return () => {
      audioEl.pause();
      audioEl.src = '';
    };
  }, [showResult]);

  const onBack = useCallback(() => {
    setShowResult(false);
    handleExit();
  }, [handleExit]);
  const onNext = useCallback(() => playNext(), [playNext]);
  const hasNext = queuePlayback && entries.length > 0;

  return {
    open: showResult,
    score: resultScore,
    scores: profileData?.scores ?? [],
    activeProfile: profileData?.active ?? null,
    nextPending: isPreparing,
    recording,
    playedAt: playedAtSnapshot,
    onBack,
    onNext: hasNext ? onNext : undefined,
  };
}
