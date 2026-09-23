import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { createProfile, deleteProfile, switchProfile } from '@/bridge/profile';
import { PROFILES } from '@/shared/query-keys';
import type { ProfileStore } from '@/types/ProfileStore';

export const useProfileMutations = () => {
  const queryClient = useQueryClient();

  return useMutation<
    void,
    Error,
    { name: string; type: 'create' | 'switch' | 'delete' },
    { previous: ProfileStore | undefined }
  >({
    mutationFn: ({ name, type: action }) => {
      switch (action) {
        case 'create':
          return createProfile(name);
        case 'switch':
          return switchProfile(name);
        case 'delete':
          return deleteProfile(name);
      }
      action satisfies never;
      throw new Error('Unknown profile mutation');
    },
    // Optimistically flip the cached active so `useCurrentProfile()` and
    // the queue's `addedBy` (captured by `useAddPlaybackQueueEntry`) reflect
    // the new pick *before* the `switch_profile` IPC returns. Without this,
    // a guest who reloads `/guest` with a stored profile lands in a
    // window where `useProfiles().data.active` still holds the previous
    // active; queueing a song during that window tags the entry with the
    // old name while the score save (which reads `ProfileStore.active` on
    // the server at IPC arrival) ends up under the right user. The two
    // attributes drift apart and the queue sidebar ends up showing
    // "Added by <previous user>" for a song the new user actually queued.
    onMutate: async ({ name, type }) => {
      if (type !== 'switch') {
        return { previous: undefined };
      }
      await queryClient.cancelQueries({ queryKey: PROFILES });
      const previous = queryClient.getQueryData<ProfileStore>(PROFILES);
      queryClient.setQueryData<ProfileStore>(PROFILES, (prev) =>
        prev === undefined ? prev : { ...prev, active: name },
      );
      return { previous };
    },
    onError: (error, _variables, context) => {
      // Roll back the optimistic flip before the toast so the UI returns
      // to the previous active if the server rejected the switch.
      if (context?.previous !== undefined) {
        queryClient.setQueryData(PROFILES, context.previous);
      }
      toast.error(`Error updating profiles: ${error.message}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PROFILES });
    },
  });
};
