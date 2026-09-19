import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { searchYouTubeVideos, type YouTubeHit } from '@/bridge/youtube';
import { useSearch } from '@/features/menu/hooks/use-search';

const DEBOUNCE_MS = 500;
const MAX_RESULTS = 5;

type UseYouTubeSearchResult = {
  hits: YouTubeHit[];
  loading: boolean;
};

/**
 * Drives the YouTube fallback list under the local songs. Mirrors the
 * debounce discipline of `useSongs` and `useSearch` — every keystroke
 * waits 500 ms before firing, and stale requests are dropped on the
 * floor via `requestIdRef`. The query + " karaoke" suffix + cap of 5
 * results all live behind the bridge, so this hook doesn't know what
 * "karaoke" means.
 *
 * The disabled / empty-query case is derived during render rather than
 * being pushed through `useState`, which keeps the effect focused on
 * "fetched results arrived" and avoids a cascading-render lint trap.
 */
export const useYouTubeSearch = ({ enabled }: { enabled: boolean }): UseYouTubeSearchResult => {
  const { search } = useSearch();
  const [rawHits, setRawHits] = useState<YouTubeHit[]>([]);
  const [rawLoading, setRawLoading] = useState(false);
  const requestIdRef = useRef(0);

  const trimmed = search.trim();
  const shouldFetch = enabled && trimmed.length > 0;

  useEffect(() => {
    if (!shouldFetch) {
      return undefined;
    }

    const timer = setTimeout(() => {
      const myId = ++requestIdRef.current;
      setRawLoading(true);
      void searchYouTubeVideos(trimmed)
        .then((next) => {
          if (requestIdRef.current === myId) {
            setRawHits(next.slice(0, MAX_RESULTS));
          }
          return;
        })
        .catch((error: unknown) => {
          if (requestIdRef.current === myId) {
            setRawHits([]);
            const message = error instanceof Error ? error.message : String(error);
            toast.error(`YouTube search failed: ${message}`);
          }
          return;
        })
        .finally(() => {
          if (requestIdRef.current === myId) {
            setRawLoading(false);
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [shouldFetch, trimmed]);

  return {
    hits: shouldFetch ? rawHits : [],
    loading: shouldFetch ? rawLoading : false,
  };
};
