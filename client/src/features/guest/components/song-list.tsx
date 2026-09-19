import { LoaderIcon, MusicIcon, StarOffIcon } from 'lucide-react';
import { useCallback, useMemo, useRef } from 'react';

import {
  YouTubeSeparator,
  YouTubeResultsList,
} from '@/features/library/components/song-list/youtube-results';
import { useBestScoresBySongForActiveProfile } from '@/features/profiles/hooks/use-best-scores-by-song';
import { useFavoritesForActiveProfile } from '@/features/profiles/hooks/use-favorites-for-active-profile';
import { Button } from '@/shared/components/ui/button';
import type { Song } from '@/types/Song';
import type { YouTubeHit } from '@/types/YouTubeHit';

import { useGuestSongs } from '../hooks/use-guest-songs';
import { SongRow } from './song-row';

type SongListProps = {
  search: string;
  artist: string | null;
  favoritesOnly: boolean;
  previewHash: string | null;
  youtubeHits?: YouTubeHit[];
  youtubeLoading?: boolean;
  youtubeVisible?: boolean;
  onPreview: (song: Song) => void;
  onPreviewStop: () => void;
  onLyrics: (song: Song) => void;
};

const ListStatus = ({
  isFetchingNextPage,
  hasNextPage,
}: {
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
}) => {
  if (isFetchingNextPage) {
    return (
      <div className="flex items-center justify-center gap-2 pb-4 text-xs text-muted-foreground">
        <LoaderIcon className="size-3 animate-spin" aria-hidden="true" />
        Loading more
      </div>
    );
  }
  if (!hasNextPage) {
    return (
      <div className="pb-6 text-center text-[0.65rem] tracking-wide uppercase text-muted-foreground/60">
        End of results
      </div>
    );
  }
  return null;
};

const LoadingState = () => (
  <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
    <LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
    Loading songs
  </div>
);

const ErrorState = ({ onRetry }: { onRetry: () => void }) => (
  <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
    <p>Could not load songs.</p>
    <Button variant="outline" size="sm" onClick={onRetry}>
      Try again
    </Button>
  </div>
);

const EmptyState = ({ favoritesOnly }: { favoritesOnly: boolean }) =>
  favoritesOnly ? (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
      <StarOffIcon className="size-6" aria-hidden="true" />
      <p>No favorites yet — tap the star on a song to save it here.</p>
    </div>
  ) : (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
      <MusicIcon className="size-6" aria-hidden="true" />
      <p>No songs match this filter.</p>
    </div>
  );

type SongsPanelProps = {
  songs: ReadonlyArray<Song>;
  totalProcessed: number;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  previewHash: string | null;
  favoritesSet: Set<string>;
  scoresByHash: Map<string, number>;
  onPreview: (song: Song) => void;
  onPreviewStop: () => void;
  onLyrics: (song: Song) => void;
  onSentinelIntersect: (node: HTMLDivElement | null) => void;
  showSentinel: boolean;
  youtubeHits: YouTubeHit[];
  youtubeLoading: boolean;
  youtubeVisible: boolean;
};

const SongsPanel = ({
  songs,
  totalProcessed,
  isFetchingNextPage,
  hasNextPage,
  previewHash,
  favoritesSet,
  scoresByHash,
  onPreview,
  onPreviewStop,
  onLyrics,
  onSentinelIntersect,
  showSentinel,
  youtubeHits,
  youtubeLoading,
  youtubeVisible,
}: SongsPanelProps) => (
  <div className="flex flex-1 flex-col overflow-hidden">
    <div className="border-b px-4 py-2 text-xs text-muted-foreground">
      Showing {songs.length} of {totalProcessed}
    </div>
    <div className="themed-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <ul className="flex flex-col gap-2 p-4 pb-2">
        {songs.map((song) => (
          <li key={song.file_hash}>
            <SongRow
              song={song}
              isPreviewing={previewHash === song.file_hash}
              isFavorite={favoritesSet.has(song.file_hash)}
              bestScore={scoresByHash.get(song.file_hash)}
              onPreview={onPreview}
              onPreviewStop={onPreviewStop}
              onLyrics={onLyrics}
            />
          </li>
        ))}
      </ul>
      <YouTubeSeparator visible={youtubeVisible} />
      <div className="px-4 pb-4">
        <YouTubeResultsList hits={youtubeHits} loading={youtubeLoading} />
      </div>
      {showSentinel ? <div ref={onSentinelIntersect} className="h-10" aria-hidden="true" /> : null}
      {showSentinel ? (
        <ListStatus isFetchingNextPage={isFetchingNextPage} hasNextPage={hasNextPage} />
      ) : null}
    </div>
  </div>
);

type PanelDataArgs = {
  query: ReturnType<typeof useGuestSongs>;
  favoritesOnly: boolean;
  favoritesSet: Set<string>;
};

type PanelData = {
  songs: ReadonlyArray<Song>;
  totalProcessed: number;
  isFetchingNextPage: boolean;
  hasMorePages: boolean;
  registerSentinel: (node: HTMLDivElement | null) => void;
};

/**
 * Pulls the intersection-observer wiring and the favorites filter into
 * a single hook so `SongList` stays under the oxlint complexity cap.
 */
const usePanelData = ({ query, favoritesOnly, favoritesSet }: PanelDataArgs): PanelData => {
  const observerRef = useRef<IntersectionObserver | null>(null);

  const allSongs = useMemo<ReadonlyArray<Song>>(() => {
    return query.data.pages.flatMap((page) => page.processed);
  }, [query.data]);
  const totalProcessed = query.data.pages[0]?.processed_count ?? 0;

  const songs = useMemo<ReadonlyArray<Song>>(() => {
    if (!favoritesOnly) {
      return allSongs;
    }
    return allSongs.filter((song) => favoritesSet.has(song.file_hash));
  }, [allSongs, favoritesOnly, favoritesSet]);

  // The intersection-observer sentinel only matters for paginated mode.
  // In favorites mode the hook does a single high-take fetch, so the
  // sentinel would just trigger no-ops.
  const hasMorePages = query.hasNextPage === true && !favoritesOnly;

  const handleSentinel = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const first = entries[0];
      if (first.isIntersecting && query.hasNextPage === true && !query.isFetchingNextPage) {
        void query.fetchNextPage();
      }
    },
    // `query` is the return value of a single `useGuestSongs` call; the
    // upstream hook is responsible for keeping the object reference stable
    // across renders, so depending on the whole object is intentional.
    [query],
  );

  const registerSentinel = useCallback(
    (node: HTMLDivElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (node === null) {
        return;
      }
      const observer = new IntersectionObserver(handleSentinel, { rootMargin: '120px' });
      observer.observe(node);
      observerRef.current = observer;
    },
    [handleSentinel],
  );

  return {
    songs,
    totalProcessed,
    isFetchingNextPage: query.isFetchingNextPage,
    hasMorePages,
    registerSentinel,
  };
};

export const SongList = ({
  search,
  artist,
  favoritesOnly,
  previewHash,
  youtubeHits,
  youtubeLoading,
  youtubeVisible,
  onPreview,
  onPreviewStop,
  onLyrics,
}: SongListProps) => {
  const query = useGuestSongs({ search, artist, favoritesOnly });
  const favoritesSet = useFavoritesForActiveProfile();
  const scoresByHash = useBestScoresBySongForActiveProfile();
  const panel = usePanelData({ query, favoritesOnly, favoritesSet });

  const handleRetry = () => {
    void query.refetch();
  };

  // With `initialData`, the result union is the Defined variant: data is
  // always present. Empty pages indicate the first fetch is still in flight,
  // so distinguish that case explicitly via `isFetching`.
  if (query.isError) {
    return <ErrorState onRetry={handleRetry} />;
  }
  // Mirror the library `SongCollection` short-circuit: only bail to the
  // empty/loading states when the YouTube fallback isn't filling in. If
  // the local search has zero matches but the YouTube toggle is on and
  // the query is non-empty, we still need to render `<SongsPanel>` so the
  // "From YouTube" rows show below the (empty) song list. Library handles
  // this via `songs.length === 0 && !youtubeVisible`; the guest had the
  // check missing, so queries with no local matches hid the YouTube rows
  // behind "No songs match this filter".
  if (panel.songs.length === 0 && !(youtubeVisible === true)) {
    if (query.isFetching && !query.isFetched) {
      return <LoadingState />;
    }
    return <EmptyState favoritesOnly={favoritesOnly} />;
  }

  return (
    <SongsPanel
      songs={panel.songs}
      totalProcessed={favoritesOnly ? panel.songs.length : panel.totalProcessed}
      isFetchingNextPage={panel.isFetchingNextPage}
      hasNextPage={panel.hasMorePages}
      previewHash={previewHash}
      favoritesSet={favoritesSet}
      scoresByHash={scoresByHash}
      onPreview={onPreview}
      onPreviewStop={onPreviewStop}
      onLyrics={onLyrics}
      onSentinelIntersect={panel.registerSentinel}
      showSentinel={!favoritesOnly}
      youtubeHits={youtubeHits ?? []}
      youtubeLoading={youtubeLoading === true}
      youtubeVisible={youtubeVisible === true}
    />
  );
};
