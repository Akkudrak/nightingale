import { useState } from 'react';

import { useYouTubeSection } from '@/features/library/hooks/use-youtube-section';
import { YouTubeToggle } from '@/features/menu/components/youtube-toggle';
import { useSearch as useSharedSearch } from '@/features/menu/hooks/use-search';
import type { Song } from '@/types/Song';

import { ArtistDrawer, ArtistSidebar } from './components/artist-list';
import { GuestFavoritesFilterButton } from './components/guest-favorites-filter-button';
import { GuestLyricsDrawer } from './components/guest-lyrics-drawer';
import { GuestQueueButton } from './components/guest-queue-button';
import { GuestQueueDrawer } from './components/guest-queue-drawer';
import { NowPlayingHeader } from './components/now-playing-header';
import { PreviewPlayer } from './components/preview-player';
import { ProfileChip } from './components/profile-chip';
import { ProfileGate } from './components/profile-gate';
import { SearchInput } from './components/search-input';
import { SongList } from './components/song-list';
import { useDebouncedValue } from './hooks/use-debounced-value';
import { useGuestProfile } from './hooks/use-guest-profile';
import { useNowPlaying, useSubscribeJukebox } from './hooks/use-now-playing';

export const GuestRoute = () => {
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 250);
  const { setSearch: setSharedSearch } = useSharedSearch();
  const [artist, setArtist] = useState<string | null>(null);
  const [previewSong, setPreviewSong] = useState<Song | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [lyricsSong, setLyricsSong] = useState<Song | null>(null);
  const youtube = useYouTubeSection();

  const handleSearchChange = (value: string) => {
    setSearchInput(value);
    // Mirror to the shared search atom so the YouTube fallback hook
    // (which reads the same atom via `useSearch`) fires alongside the
    // guest's local debounce. No re-render here for the desktop-side
    // listeners — only the guest route mounts this component.
    setSharedSearch(value);
  };

  const profile = useGuestProfile();

  useSubscribeJukebox();
  const nowPlaying = useNowPlaying();

  const handlePreview = (song: Song) => {
    setPreviewSong(song);
  };
  const handlePreviewStop = () => {
    setPreviewSong(null);
  };
  const handleLyrics = (song: Song) => {
    setLyricsSong(song);
  };
  const handleLyricsClose = () => {
    setLyricsSong(null);
  };

  if (profile.name === null) {
    return (
      <ProfileGate
        knownNames={profile.knownNames}
        hasResolved={profile.hasResolved}
        loadError={profile.loadError}
        onSelect={profile.switchTo}
        onCreate={profile.createAndSelect}
        onRetry={profile.retry}
      />
    );
  }

  return (
    <div className="flex h-dvh w-full flex-col bg-background text-foreground">
      <NowPlayingHeader {...nowPlaying} />
      <div className="flex shrink-0 flex-col gap-1.5 border-b px-3 py-2 sm:px-4">
        <div className="flex items-center gap-2">
          <SearchInput value={searchInput} onChange={handleSearchChange} />
          <YouTubeToggle checked={youtube.enabled} onChange={youtube.setEnabled} />
          <ProfileChip
            name={profile.name}
            knownNames={profile.knownNames}
            onSwitch={profile.switchTo}
            onSignOut={profile.signOut}
          />
        </div>
        <div className="flex items-center gap-2">
          <ArtistDrawer selected={artist} onSelect={setArtist} />
          <div className="ml-auto flex items-center gap-1.5">
            <GuestFavoritesFilterButton
              active={favoritesOnly}
              onClick={() => setFavoritesOnly((v) => !v)}
            />
            <GuestQueueDrawer trigger={<GuestQueueButton />} />
          </div>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden pb-20">
        <ArtistSidebar selected={artist} onSelect={setArtist} />
        <SongList
          search={search}
          artist={artist}
          favoritesOnly={favoritesOnly}
          previewHash={previewSong?.file_hash ?? null}
          youtubeHits={youtube.hits}
          youtubeLoading={youtube.loading}
          youtubeVisible={youtube.visible}
          onPreview={handlePreview}
          onPreviewStop={handlePreviewStop}
          onLyrics={handleLyrics}
        />
      </div>
      <PreviewPlayer song={previewSong} onClose={handlePreviewStop} />
      <GuestLyricsDrawer song={lyricsSong} onClose={handleLyricsClose} />
    </div>
  );
};
