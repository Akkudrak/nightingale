import { useState } from 'react';

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
  const [artist, setArtist] = useState<string | null>(null);
  const [previewSong, setPreviewSong] = useState<Song | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [lyricsSong, setLyricsSong] = useState<Song | null>(null);

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
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2 sm:px-4">
        <ArtistDrawer selected={artist} onSelect={setArtist} />
        <SearchInput value={searchInput} onChange={setSearchInput} />
        <div className="flex shrink-0 items-center gap-1.5">
          <GuestFavoritesFilterButton
            active={favoritesOnly}
            onClick={() => setFavoritesOnly((v) => !v)}
          />
          <GuestQueueDrawer trigger={<GuestQueueButton />} />
          <ProfileChip
            name={profile.name}
            knownNames={profile.knownNames}
            onSwitch={profile.switchTo}
            onSignOut={profile.signOut}
          />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden pb-20">
        <ArtistSidebar selected={artist} onSelect={setArtist} />
        <SongList
          search={search}
          artist={artist}
          favoritesOnly={favoritesOnly}
          previewHash={previewSong?.file_hash ?? null}
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
