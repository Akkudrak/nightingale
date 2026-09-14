import { LoaderIcon, MusicIcon, StarOffIcon } from 'lucide-react';
import { useCallback, useMemo, useRef } from 'react';

import { useBestScoresBySongForActiveProfile } from '@/features/profiles/hooks/use-best-scores-by-song';
import { useFavoritesForActiveProfile } from '@/features/profiles/hooks/use-favorites-for-active-profile';
import { Button } from '@/shared/components/ui/button';
import type { Song } from '@/types/Song';

import { useGuestSongs } from '../hooks/use-guest-songs';
import { SongRow } from './song-row';

type SongListProps = {
  search: string;
  artist: string | null;
  favoritesOnly: boolean;
  previewHash: string | null;
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
}: SongsPanelProps) => (
  <div className="flex flex-1 flex-col overflow-hidden">
    <div className="border-b px-4 py-2 text-xs text-muted-foreground">
      Showing {songs.length} of {totalProcessed}
    </div>
    <div className="themed-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <ul className="flex flex-col gap-2 p-4 pb-6">
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
      {showSentinel ? <div ref={onSentinelIntersect} className="h-10" aria-hidden="true" /> : null}
      {showSentinel ? (
        <ListStatus isFetchingNextPage={isFetchingNextPage} hasNextPage={hasNextPage} />
      ) : null}
    </div>
  </div>
);

export const SongList = ({
  search,
  artist,
  favoritesOnly,
  previewHash,
  onPreview,
  onPreviewStop,
  onLyrics,
}: SongListProps) => {
  const query = useGuestSongs({ search, artist, favoritesOnly });
  const { data, isError, isFetchingNextPage, hasNextPage, fetchNextPage, refetch } = query;
  const observerRef = useRef<IntersectionObserver | null>(null);
  const favoritesSet = useFavoritesForActiveProfile();
  const scoresByHash = useBestScoresBySongForActiveProfile();

  const allSongs = useMemo<ReadonlyArray<Song>>(() => {
    return data.pages.flatMap((page) => page.processed);
  }, [data]);
  const totalProcessed = data.pages[0]?.processed_count ?? 0;

  const songs = useMemo<ReadonlyArray<Song>>(() => {
    if (!favoritesOnly) {
      return allSongs;
    }
    return allSongs.filter((song) => favoritesSet.has(song.file_hash));
  }, [allSongs, favoritesOnly, favoritesSet]);

  // The intersection-observer sentinel only matters for paginated mode. In
  // favorites mode the hook does a single high-take fetch, so the sentinel
  // would just trigger no-ops.
  const hasMorePages = hasNextPage === true && !favoritesOnly;

  const handleSentinel = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const first = entries[0];
      if (first.isIntersecting && hasNextPage === true && !isFetchingNextPage) {
        void fetchNextPage();
      }
    },
    [hasNextPage, isFetchingNextPage, fetchNextPage],
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

  const handleRetry = () => {
    void refetch();
  };

  // With `initialData`, the result union is the Defined variant: data is
  // always present. Empty pages indicate the first fetch is still in flight,
  // so distinguish that case explicitly via `isFetching`.
  if (isError) {
    return <ErrorState onRetry={handleRetry} />;
  }
  if (songs.length === 0 && query.isFetching && !query.isFetched) {
    return <LoadingState />;
  }
  if (songs.length === 0) {
    return <EmptyState favoritesOnly={favoritesOnly} />;
  }

  return (
    <SongsPanel
      songs={songs}
      totalProcessed={favoritesOnly ? songs.length : totalProcessed}
      isFetchingNextPage={isFetchingNextPage}
      hasNextPage={hasMorePages}
      previewHash={previewHash}
      favoritesSet={favoritesSet}
      scoresByHash={scoresByHash}
      onPreview={onPreview}
      onPreviewStop={onPreviewStop}
      onLyrics={onLyrics}
      onSentinelIntersect={registerSentinel}
      showSentinel={!favoritesOnly}
    />
  );
};
