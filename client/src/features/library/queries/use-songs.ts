import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import { getPreloadedSongsMeta, loadAnalysisQueue, loadSongs, loadSongsMeta } from '@/bridge/songs';
import { useLibraryFilter } from '@/features/menu/hooks/use-library-filter';
import { useSearch } from '@/features/menu/hooks/use-search';
import { useConfig } from '@/shared/config/use-config';
import { ANALYSIS_QUEUE, SONGS, SONGS_META, MENU } from '@/shared/query-keys';
import type { AnalysisQueue } from '@/types/AnalysisQueue';
import type { LoadSongsParams } from '@/types/LoadSongsParams';
import type { SongsMeta } from '@/types/SongsMeta';
import type { SongSort } from '@/types/SongSort';

const PAGE_SIZE = 25;
const DEFAULT_REFETCH_INTERVAL = 2500;

export const useSongsMeta = () => {
  const queryClient = useQueryClient();
  const [prevMatched, setPrevMatched] = useState(true);
  const preloaded = getPreloadedSongsMeta();

  return useQuery({
    queryKey: SONGS_META,
    queryFn: loadSongsMeta,
    refetchInterval: DEFAULT_REFETCH_INTERVAL,
    ...(preloaded !== undefined ? { initialData: preloaded } : {}),
    onSuccess: ({ count, processed_count }: SongsMeta) => {
      if (count !== processed_count) {
        setPrevMatched(false);
        void queryClient.invalidateQueries({ queryKey: SONGS });
        void queryClient.invalidateQueries({ queryKey: MENU });
      } else {
        if (!prevMatched) {
          setPrevMatched(true);
          void queryClient.invalidateQueries({ queryKey: SONGS });
          void queryClient.invalidateQueries({ queryKey: MENU });
        }
      }
    },
  });
};

type SongsFilterValues = {
  search: string;
  artist: string | null;
  album: string | null;
  playlist: string | null;
  query: string | null;
  status: string | null;
  transcript_source: string | null;
  genre: string | null;
  first_letter: string | null;
};

const buildLoadSongsParams = (
  values: SongsFilterValues,
  sort: readonly SongSort[],
  skip: number,
): LoadSongsParams => ({
  search: values.search || null,
  filters: {
    artist: values.artist,
    album: values.album,
    playlist: values.playlist,
    query: values.query,
    status: values.status,
    transcript_source: values.transcript_source,
    search: null,
    genre: values.genre,
    first_letter: values.first_letter,
  },
  // First-launch default: most-recently-added first. The user can
  // override later by setting a config sort; the backend then
  // ignores this fallback. Spreading `sort` produces a mutable
  // Array<SongSort> for the `LoadSongsParams.sort` field.
  sort: sort.length === 0 ? [{ column: 'created_at', direction: 'descending' }] : [...sort],
  skip,
  take: PAGE_SIZE,
});

export const useSongs = () => {
  const { data: config } = useConfig();
  const { search } = useSearch();
  const { artist, album, playlist, query, status, transcript_source, genre, first_letter } =
    useLibraryFilter();
  const sort = config?.song_list_sort ?? [];

  return useInfiniteQuery({
    queryKey: [
      ...SONGS,
      search,
      artist,
      album,
      playlist,
      query,
      status,
      transcript_source,
      genre,
      first_letter,
      sort,
    ],
    queryFn: ({ pageParam = 0 }: { pageParam?: number }) =>
      loadSongs(
        buildLoadSongsParams(
          {
            search,
            artist: artist ?? null,
            album: album ?? null,
            playlist: playlist ?? null,
            query: query ?? null,
            status: status ?? null,
            transcript_source: transcript_source ?? null,
            genre: genre ?? null,
            first_letter: first_letter ?? null,
          },
          sort,
          pageParam,
        ),
      ),
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, page) => sum + page.processed.length, 0);
      return loaded < lastPage.processed_count ? loaded : undefined;
    },
  });
};

export const useAnalysisQueue = () => {
  const queryClient = useQueryClient();
  const prevEntriesRef = useRef<string | null>(null);

  return useQuery({
    queryKey: ANALYSIS_QUEUE,
    queryFn: loadAnalysisQueue,
    refetchInterval: 2500,
    onSuccess: (data: AnalysisQueue) => {
      const entries = Object.entries(data.entries)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([hash, status]) => `${hash}:${JSON.stringify(status)}`)
        .join('|');
      const previous = prevEntriesRef.current;

      if (previous !== null && previous !== entries) {
        void queryClient.invalidateQueries({ queryKey: SONGS });
        void queryClient.invalidateQueries({ queryKey: MENU });
        void queryClient.invalidateQueries({ queryKey: SONGS_META });
      }

      prevEntriesRef.current = entries;
    },
  });
};
