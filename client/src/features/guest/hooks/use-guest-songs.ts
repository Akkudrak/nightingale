import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';

import { loadSongs } from '@/bridge/songs';
import { EMPTY_LIBRARY_FILTER } from '@/features/library/lib/library-menu-filter';
import type { LoadSongsParams } from '@/types/LoadSongsParams';
import type { SongsStore } from '@/types/SongsStore';

const PAGE_SIZE = 25;
// Favorites mode is meant to fit all favorites in a single fetch so the
// intersection-observer "load more" mechanic gets disabled in the consumer.
const FAVORITES_TAKE = 10_000;

const EMPTY_DATA: InfiniteData<SongsStore> = { pages: [], pageParams: [] };

type Args = {
  search: string;
  artist: string | null;
  favoritesOnly: boolean;
};

export const useGuestSongs = ({ search, artist, favoritesOnly }: Args) =>
  useInfiniteQuery({
    queryKey: ['guest', 'songs', search, artist, favoritesOnly ? 'favorites' : 'all'],
    queryFn: ({ pageParam = 0 }: { pageParam?: number }) => {
      const trimmed = search.trim();
      const params: LoadSongsParams = {
        search: trimmed === '' ? null : trimmed,
        filters: { ...EMPTY_LIBRARY_FILTER, artist: artist ?? null },
        sort: null,
        skip: favoritesOnly ? 0 : pageParam,
        take: favoritesOnly ? FAVORITES_TAKE : PAGE_SIZE,
      };
      return loadSongs(params);
    },
    getNextPageParam: (lastPage, allPages) => {
      if (favoritesOnly) {
        return undefined;
      }
      // TanStack Query v4 invokes getNextPageParam with undefined on the
      // very first render even when initialData is set, so the upstream
      // type narrowing does not reflect the actual runtime call.
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (lastPage === undefined) {
        return undefined;
      }
      const loaded = allPages.reduce((sum, page) => sum + page.processed.length, 0);
      return loaded < lastPage.processed_count ? loaded : undefined;
    },
    initialData: EMPTY_DATA,
  });
