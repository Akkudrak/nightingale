import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import successSoundUrl from '@/assets/sounds/success.mp3';
import type { PlaybackPlayer } from '@/bridge/playback-session';
import { addScore } from '@/bridge/profile';
import {
  usePlaybackQueueQuery,
  useStartNextPlaybackQueueSong,
} from '@/features/playback-queue/use-playback-queue';
import {
  usePlaybackMicState,
  usePlaybackTranscriptActions,
  usePlaybackTranscriptState,
  usePlaybackTransportActions,
  usePlaybackTransportState,
} from '@/features/playback/providers';
import { useProfiles } from '@/features/profiles/queries/use-profiles';
import { useRoomPlayback } from '@/features/singverse-room/room-playback-context';
import { t } from '@/i18n';
import { useLatestRef } from '@/shared/hooks/use-latest-ref';
import { defaultPlayerColor, type PlayerColor } from '@/shared/player-colors';
import { PROFILES } from '@/shared/query-keys';
import type { ScoreRecord } from '@/types/ScoreRecord';
import type { Song } from '@/types/Song';

export type PlaybackPlayerResult = {
  id: string;
  profile: string | null;
  color: PlayerColor;
  score: number;
};

type FinalResultsInput = {
  multiplayer: boolean;
  players: ReturnType<typeof usePlaybackMicState>['players'];
  activeProfile: string | null;
  soloScore: number;
};

function buildFinalResults(input: FinalResultsInput): PlaybackPlayerResult[] {
  if (!input.multiplayer) {
    return [
      {
        id: 'solo',
        profile: input.activeProfile,
        color: defaultPlayerColor(0),
        score: input.soloScore,
      },
    ];
  }
  return input.players.map((player) => ({
    id: player.id,
    profile: player.profile,
    color: player.color,
    score: player.rawScore,
  }));
}

/** Results always show for multiplayer and queues; solo only when something was sung. */
function shouldShowResults(
  multiplayer: boolean,
  queuePlayback: boolean,
  results: PlaybackPlayerResult[],
): boolean {
  return multiplayer || queuePlayback || results.some((result) => result.score > 0);
}

function finishReady(
  isFinished: boolean,
  skipOutroPending: boolean,
  profilesLoading: boolean,
  alreadyHandled: boolean,
): boolean {
  return (isFinished || skipOutroPending) && !profilesLoading && !alreadyHandled;
}

export type PlaybackResult = {
  open: boolean;
  results: PlaybackPlayerResult[];
  scores: ScoreRecord[];
  nextPending: boolean;
  onBack: () => void;
  onNext?: (players?: readonly PlaybackPlayer[]) => void;
};

export function usePlaybackResult(
  song: Song,
  queuePlayback: boolean,
  players: readonly PlaybackPlayer[],
): PlaybackResult {
  const fileHash = song.file_hash;
  const room = useRoomPlayback();
  const queryClient = useQueryClient();
  const { data: profileData, isLoading: profilesLoading } = useProfiles();
  const { data: entries = [] } = usePlaybackQueueQuery();
  const { isPreparing, playNext } = useStartNextPlaybackQueueSong(entries);

  const { isFinished } = usePlaybackTransportState();
  const { handleExit } = usePlaybackTransportActions();
  const { rawScore, players: micPlayers, multiplayer } = usePlaybackMicState();
  const { skipOutroPending } = usePlaybackTranscriptState();
  const { clearSkipOutroPending } = usePlaybackTranscriptActions();

  const [showResult, setShowResult] = useState(false);
  const [results, setResults] = useState<PlaybackPlayerResult[]>([]);
  const micPlayersRef = useLatestRef(micPlayers);
  const scoreRef = useLatestRef(rawScore);
  const finishHandledRef = useRef(false);
  // In a SingVerse room the singer is the room's, and the score is reported to the room.
  const activeProfile = room === null ? (profileData?.active ?? null) : room.singer;

  useEffect(() => {
    if (!finishReady(isFinished, skipOutroPending, profilesLoading, finishHandledRef.current)) {
      return;
    }

    finishHandledRef.current = true;
    clearSkipOutroPending();

    const finalResults = buildFinalResults({
      multiplayer,
      players: micPlayersRef.current,
      activeProfile,
      soloScore: scoreRef.current,
    });

    // A SingVerse room saves the score on the singer's SingVerse profile instead.
    if (room !== null) {
      room.onFinished(finalResults[0].score);
      setResults(finalResults);
      setShowResult(true);
      return;
    }

    if (!shouldShowResults(multiplayer, queuePlayback, finalResults)) {
      handleExit();
      return;
    }

    void (async () => {
      try {
        await Promise.all(
          finalResults.flatMap((result) =>
            result.profile === null ? [] : [addScore(fileHash, result.score, result.profile)],
          ),
        );
        if (finalResults.some((result) => result.profile !== null)) {
          await queryClient.invalidateQueries({ queryKey: PROFILES });
        }
      } catch (error) {
        toast.error(
          t('playback.usePlaybackResult.couldNotSaveScore', {
            value1: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      setResults(finalResults.toSorted((left, right) => right.score - left.score));
      setShowResult(true);
    })();
  }, [
    clearSkipOutroPending,
    fileHash,
    handleExit,
    isFinished,
    micPlayersRef,
    multiplayer,
    activeProfile,
    profilesLoading,
    queryClient,
    queuePlayback,
    room,
    scoreRef,
    skipOutroPending,
  ]);

  useEffect(() => {
    if (!showResult) {
      return undefined;
    }

    const audioElement = new Audio(successSoundUrl);
    void audioElement.play().catch(() => {});

    return () => {
      audioElement.pause();
      audioElement.src = '';
    };
  }, [showResult]);

  const onBack = useCallback(() => {
    setShowResult(false);
    handleExit();
  }, [handleExit]);
  const onNext = useCallback(
    (nextPlayers: readonly PlaybackPlayer[] = players) => playNext([...nextPlayers]),
    [playNext, players],
  );
  const hasNext = queuePlayback && entries.length > 0;

  if (room !== null) {
    // The room's lobby introduces the next singer: "next" just leaves this song.
    return {
      open: showResult,
      results,
      scores: [],
      nextPending: false,
      onBack,
      onNext: onBack,
    };
  }

  return {
    open: showResult,
    results,
    scores: profileData?.scores ?? [],
    nextPending: isPreparing,
    onBack,
    onNext: hasNext ? onNext : undefined,
  };
}
