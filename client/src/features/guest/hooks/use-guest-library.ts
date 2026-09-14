import { useQuery } from '@tanstack/react-query';

import { loadLibraryMenuItems } from '@/bridge/library';
import type { LibraryMenuItem } from '@/types/LibraryMenuItem';

export const useGuestArtists = () =>
  useQuery<LibraryMenuItem[]>({
    queryKey: ['guest', 'library-artists'],
    queryFn: async () => {
      const items = await loadLibraryMenuItems();
      return items.artists;
    },
    staleTime: 60_000,
  });
