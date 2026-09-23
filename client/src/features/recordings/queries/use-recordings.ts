import { useQuery } from '@tanstack/react-query';

import { loadRecordings } from '@/bridge/recording';
import { RECORDINGS } from '@/shared/query-keys';
import type { RecordingRecord } from '@/types/RecordingRecord';

const EMPTY_RECORDINGS: RecordingRecord[] = [];

/**
 * Loads every saved recording, newest first. Mirrors `usePlaybackQueueQuery`:
 * the cache is the single source of truth for the history dialog and is
 * invalidated by the save/delete mutations.
 */
export const useRecordingsQuery = () => {
  const query = useQuery({
    queryKey: RECORDINGS,
    queryFn: loadRecordings,
    staleTime: 30_000,
  });
  return { ...query, data: query.data ?? EMPTY_RECORDINGS };
};
