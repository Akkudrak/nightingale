import { useCallback, useEffect, useRef, useState } from 'react';

import { switchProfile } from '@/bridge/profile';
import { useProfileMutations } from '@/features/profiles/mutations/use-profile-mutations';
import { useProfiles } from '@/features/profiles/queries/use-profiles';

const STORAGE_KEY = 'nightingale:guest:profile';

const readStored = (): string | null => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

const writeStored = (name: string | null): void => {
  try {
    if (name === null) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, name);
    }
  } catch {
    // Storage may be unavailable (private mode, quota); the picker just
    // won't remember the choice across reloads.
  }
};

const resolveLoadError = (profiles: ReturnType<typeof useProfiles>): Error | null => {
  if (!profiles.isError) {
    return null;
  }
  if (profiles.error instanceof Error) {
    return profiles.error;
  }
  return new Error('Failed to load profiles');
};

export type GuestProfile = {
  name: string | null;
  knownNames: ReadonlyArray<string>;
  hasResolved: boolean;
  loadError: Error | null;
  retry: () => void;
  switchTo: (name: string) => Promise<void>;
  createAndSelect: (name: string) => Promise<void>;
  signOut: () => void;
};

// Resolves which profile the guest should be treated as. Reads a name from
// localStorage on mount and reconciles it with the server's profile list so
// the gate only shows up when no valid name is stored. The picked name is
// also pushed to the server as the active profile so any transport-level
// caller that consults `ProfileStore.active` stays consistent.
export const useGuestProfile = (): GuestProfile => {
  const [stored, setStored] = useState<string | null>(() => readStored());
  const profiles = useProfiles();
  const { mutateAsync, reset } = useProfileMutations();

  const knownNames = profiles.data?.profiles ?? [];
  // The stored name only counts when the server still recognizes it.
  const valid = stored !== null && knownNames.includes(stored) ? stored : null;

  // Once the initial profile list settles, tell the server which stored
  // name is active so the queue attribution (when supported) lines up with
  // what the guest picked locally. A ref guards against re-firing on later
  // refreshes; the catch path clears the local mirror so the gate can
  // reappear if the server rejects the stored name.
  const reconciledRef = useRef(false);
  useEffect(() => {
    if (reconciledRef.current || profiles.isLoading) {
      return;
    }
    reconciledRef.current = true;
    if (valid !== null) {
      void switchProfile(valid).catch(() => {
        writeStored(null);
        setStored(null);
      });
    }
  }, [valid, profiles.isLoading]);

  const switchTo = useCallback(
    async (name: string): Promise<void> => {
      await mutateAsync({ name, type: 'switch' });
      writeStored(name);
      setStored(name);
    },
    [mutateAsync],
  );

  const createAndSelect = useCallback(
    async (name: string): Promise<void> => {
      await mutateAsync({ name, type: 'create' });
      await mutateAsync({ name, type: 'switch' });
      writeStored(name);
      setStored(name);
    },
    [mutateAsync],
  );

  const signOut = useCallback((): void => {
    writeStored(null);
    setStored(null);
  }, []);

  const retry = useCallback((): void => {
    reset();
    void profiles.refetch();
  }, [profiles, reset]);

  return {
    name: valid,
    knownNames,
    hasResolved: !profiles.isLoading,
    loadError: resolveLoadError(profiles),
    retry,
    switchTo,
    createAndSelect,
    signOut,
  };
};
