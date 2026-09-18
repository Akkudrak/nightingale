import { useMemo } from 'react';

import { useBestScoresBySongForActiveProfile } from '@/features/profiles/hooks/use-best-scores-by-song';
import type { Song } from '@/types/Song';

import { songKey } from '../shared/song-key';
import { SONG_COLUMNS } from '../song-columns';
import type { SongItemProps } from '../types';
import { SongTableRow } from './song-table-row';

type SongGenreSectionedProps = {
  songs: Song[];
  getItemProps: (song: Song, index: number) => SongItemProps;
};

type Group = {
  /** Sort key: empty string for the unsorted/genre-less bucket. */
  key: string;
  /** Display label shown in the section header. */
  label: string;
  songs: Song[];
};

const UNGROUPED_KEY = '';
const UNGROUPED_LABEL = 'Sin género';

// One <tbody> per group; the section header is the first <tr> inside it.
// CSS (client/src/app/app.css) makes the header <th> sticky so the genre
// stays pinned while the songs in that section scroll under it.
const GroupSection = ({
  group,
  startIndex,
  bestScores,
  getItemProps,
}: {
  group: Group;
  startIndex: number;
  bestScores: Map<string, number>;
  getItemProps: (song: Song, index: number) => SongItemProps;
}) => (
  <tbody>
    <tr className="song-genre-section">
      <th colSpan={SONG_COLUMNS.length}>{`${group.label} (${group.songs.length})`}</th>
    </tr>
    {group.songs.map((song, localIndex) => {
      const globalIndex = startIndex + localIndex;
      return (
        <SongTableRow
          key={songKey(song)}
          {...getItemProps(song, globalIndex)}
          bestScore={bestScores.get(song.file_hash)}
        />
      );
    })}
  </tbody>
);

export const SongGenreSectioned = ({ songs, getItemProps }: SongGenreSectionedProps) => {
  const bestScores = useBestScoresBySongForActiveProfile();

  const groups = useMemo<Group[]>(() => {
    if (songs.length === 0) {
      return [];
    }
    const map = new Map<string, Song[]>();
    for (const song of songs) {
      const genre = song.genre?.trim() ?? '';
      const key = genre === '' ? UNGROUPED_KEY : genre;
      const bucket = map.get(key);
      if (bucket === undefined) {
        map.set(key, [song]);
      } else {
        bucket.push(song);
      }
    }
    const sorted: Group[] = [];
    for (const [key, groupSongs] of map) {
      sorted.push({
        key,
        label: key === UNGROUPED_KEY ? UNGROUPED_LABEL : key,
        songs: groupSongs,
      });
    }
    sorted.sort((a, b) => {
      // Empty ("Sin género") bucket always last -- it's the catch-all and
      // sits visually at the bottom of the list.
      if (a.key === UNGROUPED_KEY) {
        return 1;
      }
      if (b.key === UNGROUPED_KEY) {
        return -1;
      }
      return a.label.localeCompare(b.label);
    });
    return sorted;
  }, [songs]);

  if (groups.length === 0) {
    return null;
  }

  let cursor = 0;
  return (
    <table className="w-full table-fixed border-separate border-spacing-0 text-xs">
      {groups.map((group) => {
        const startIndex = cursor;
        cursor += group.songs.length;
        return (
          <GroupSection
            key={group.key}
            group={group}
            startIndex={startIndex}
            bestScores={bestScores}
            getItemProps={getItemProps}
          />
        );
      })}
    </table>
  );
};
