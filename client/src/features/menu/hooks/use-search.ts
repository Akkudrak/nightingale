import { atom, useAtom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

export const searchAtom = atom('');

/**
 * `atomWithStorage`'s default seeds the atom with `initialValue`
 * rather than reading from localStorage on first render. Passing
 * `getOnInit: true` makes a previously-ticked toolbar checkbox render
 * ticked immediately — without it, the toolbar would briefly show
 * "unchecked" before re-rendering the persisted state, which would
 * flash YouTube results on/off.
 */
const youtubeEnabledAtom = atomWithStorage<boolean>(
  'nightingale:youtube_search_enabled',
  false,
  undefined,
  { getOnInit: true },
);

export const useSearch = () => {
  const [search, setSearch] = useAtom(searchAtom);

  return {
    search,
    setSearch,
  };
};

export const useYouTubeEnabled = () => {
  const [enabled, setEnabled] = useAtom(youtubeEnabledAtom);

  return {
    enabled,
    setEnabled,
  };
};
