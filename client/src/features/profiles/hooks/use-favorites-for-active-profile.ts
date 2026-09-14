import { useMemo } from 'react';

import { useProfiles } from '@/features/profiles/queries/use-profiles';

export function useFavoritesForActiveProfile(): Set<string> {
  const { data } = useProfiles();
  const active = data?.active;
  const favorites = data?.favorites;

  return useMemo(() => {
    const set = new Set<string>();
    if (typeof active !== 'string' || active === '') {
      return set;
    }

    for (const r of favorites ?? []) {
      if (r.profile === active) {
        set.add(r.song_hash);
      }
    }

    return set;
  }, [active, favorites]);
}
