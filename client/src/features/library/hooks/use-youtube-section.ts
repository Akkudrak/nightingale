import { useMemo } from 'react';

import { useYouTubeSearch } from '@/features/library/hooks/use-youtube-search';
import { useSearch, useYouTubeEnabled } from '@/features/menu/hooks/use-search';
import type { YouTubeHit } from '@/types/YouTubeHit';

type UseYouTubeSectionResult = {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  hits: YouTubeHit[];
  loading: boolean;
  visible: boolean;
};

/**
 * Glue hook for the song-list (desktop and /guest). Combines the
 * enabled toggle, the search query, and the YouTube query hook into
 * the props the lists care about — pulling them inline into a page
 * body would push the file past oxlint's complexity cap (the same
 * role `useServerGuestMode` plays for the settings page).
 */
export const useYouTubeSection = (): UseYouTubeSectionResult => {
  const { enabled, setEnabled } = useYouTubeEnabled();
  const { search } = useSearch();
  const { hits, loading } = useYouTubeSearch({ enabled });
  const trimmedLength = search.trim().length;
  const visible = useMemo(
    () => enabled && (hits.length > 0 || loading || trimmedLength > 0),
    [enabled, hits.length, loading, trimmedLength],
  );
  return { enabled, setEnabled, hits, loading, visible };
};
