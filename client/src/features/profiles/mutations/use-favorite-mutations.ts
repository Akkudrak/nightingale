import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { addFavorite, removeFavorite } from '@/bridge/profile';
import { PROFILES } from '@/shared/query-keys';
import type { ProfileStore } from '@/types/ProfileStore';

type ToggleArgs = { songHash: string; next: boolean };

const toggleFavoriteAt = (
  store: ProfileStore | undefined,
  songHash: string,
  next: boolean,
  now: number,
): ProfileStore | undefined => {
  if (!store) {
    return store;
  }
  const active = store.active;
  if (typeof active !== 'string' || active === '') {
    return store;
  }
  if (next) {
    if (store.favorites.some((r) => r.profile === active && r.song_hash === songHash)) {
      return store;
    }
    return {
      ...store,
      favorites: [
        ...store.favorites,
        { profile: active, song_hash: songHash, favorited_at: BigInt(now) },
      ],
    };
  }
  return {
    ...store,
    favorites: store.favorites.filter((r) => !(r.profile === active && r.song_hash === songHash)),
  };
};

/** Toggle the active profile's favorite on a single song. The flip is applied
 * to the cached `PROFILES` store optimistically so the star updates instantly;
 * on error the cache is rolled back and a toast is shown. */
export const useToggleFavorite = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ songHash, next }: ToggleArgs) =>
      next ? addFavorite(songHash) : removeFavorite(songHash),
    onMutate: async ({ songHash, next }) => {
      await queryClient.cancelQueries({ queryKey: PROFILES });
      const previous = queryClient.getQueryData<ProfileStore>(PROFILES);
      queryClient.setQueryData<ProfileStore>(PROFILES, (prev) =>
        toggleFavoriteAt(prev, songHash, next, Math.floor(Date.now() / 1000)),
      );
      return { previous };
    },
    onError: (error: Error, _vars, context) => {
      const ctx: { previous?: ProfileStore } | undefined = context;
      if (ctx?.previous) {
        queryClient.setQueryData<ProfileStore>(PROFILES, ctx.previous);
      }
      toast.error(`Could not update favorites: ${error.message}`);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: PROFILES });
    },
  });
};
