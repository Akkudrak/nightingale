import { useQuery } from '@tanstack/react-query';

import { recordingUrl } from '@/bridge/recording';

type ResolvedUrl = {
  url: string;
  loading: boolean;
  error: string | null;
};

const EMPTY_STATE: ResolvedUrl = { url: '', loading: false, error: null };

const buildKey = (id: string | null): readonly ['recording-url', string | null] =>
  ['recording-url', id] as const;

/**
 * Resolves the playable URL for a single recording id.
 *
 * Always async: web mode hands back the API route string via a resolved
 * promise, Tauri mode goes through `get_recording_path` so the asset
 * protocol can rewrite the absolute WAV path.
 *
 * The query key includes the id, so react-query keeps a tiny per-id
 * cache for the lifetime of the dialog. Stale time is intentionally
 * long — the data folder only moves on operator action — so re-clicks
 * on the same row don't re-issue the IPC.
 */
export const useRecordingUrl = (id: string | null): ResolvedUrl => {
  const query = useQuery({
    queryKey: buildKey(id),
    queryFn: () => {
      if (id === null) {
        return Promise.reject(new Error('no recording id'));
      }
      return recordingUrl(id);
    },
    enabled: id !== null,
    staleTime: 5 * 60 * 1000,
  });

  if (id === null) {
    return EMPTY_STATE;
  }

  if (query.isLoading) {
    return { url: '', loading: true, error: null };
  }

  if (query.isError) {
    const error: unknown = query.error;
    const message = error instanceof Error ? error.message : String(error);
    return { url: '', loading: false, error: message };
  }

  const url = query.data;
  return {
    url,
    loading: false,
    error: url === '' ? 'recording not found' : null,
  };
};
