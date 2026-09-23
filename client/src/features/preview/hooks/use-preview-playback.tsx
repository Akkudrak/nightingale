/**
 * Audio engine for the global preview bar. Extracted from the guest-mode
 * `PreviewPlayer` so the desktop song list can reuse the exact same
 * drift-sync + vocals-at-0.55 logic without duplicating it.
 *
 * URL resolution always goes through `playbackAdapter.getAudioPaths` so
 * the Tauri session token / web asset proxy is applied identically. A tiny
 * module-scoped LRU keeps repeated clicks snappy across mounts.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { playbackAdapter } from '@/bridge/playback';

import type { PreviewSong } from '../atoms';

const GUIDE_VOCALS_VOLUME = 0.55;
const DRIFT_RESYNC_SECONDS = 0.2;
const URL_CACHE_LIMIT = 8;

type ResolvedUrls = {
  instrumental: string | null;
  vocals: string | null;
  fallback: string | null;
};

const EMPTY_URLS: ResolvedUrls = {
  instrumental: null,
  vocals: null,
  fallback: null,
};

const resolveUrls = async (song: PreviewSong): Promise<ResolvedUrls> => {
  if (song.isAnalyzed && !song.noStems) {
    const paths = await playbackAdapter.getAudioPaths(song.hash);
    return { instrumental: paths.instrumental, vocals: paths.vocals, fallback: null };
  }
  const fallback = `/api/asset?path=${encodeURIComponent(song.path)}`;
  return { instrumental: null, vocals: null, fallback };
};

const syncVocalsToInstrumental = (
  instrumental: HTMLAudioElement,
  vocals: HTMLAudioElement | null,
  hasStems: boolean,
  vocalsBroken: boolean,
) => {
  if (vocals === null || !hasStems || vocalsBroken) {
    return;
  }
  if (Math.abs(vocals.currentTime - instrumental.currentTime) > DRIFT_RESYNC_SECONDS) {
    vocals.currentTime = instrumental.currentTime;
  }
};

// Module-scoped LRU keyed by song hash. Stable across preview-bar
// mount/unmount cycles (the bar lives in `Sidebar` which stays mounted
// across page transitions). Listener fan-out keeps React subscribers in
// sync when entries land.
const urlCache: Map<string, ResolvedUrls> = new Map();
const cacheListeners = new Set<() => void>();

const emitCacheChange = (): void => {
  for (const listener of cacheListeners) {
    listener();
  }
};

const rememberUrls = (hash: string, urls: ResolvedUrls): void => {
  if (urlCache.has(hash)) {
    urlCache.delete(hash);
  }
  urlCache.set(hash, urls);
  while (urlCache.size > URL_CACHE_LIMIT) {
    const oldestKey = urlCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    urlCache.delete(oldestKey);
  }
};

const readCachedUrls = (hash: string | null): ResolvedUrls =>
  hash === null ? EMPTY_URLS : (urlCache.get(hash) ?? EMPTY_URLS);

const subscribeCache = (listener: () => void): (() => void) => {
  cacheListeners.add(listener);
  return () => {
    cacheListeners.delete(listener);
  };
};

/**
 * Subscribes to the LRU and triggers a fetch when the song hash changes
 * without an entry. The render-time snapshot comes from `useSyncExternalStore`
 * so we never need synchronous setState for cache hits or the no-song path.
 */
const useCachedUrls = (song: PreviewSong | null): ResolvedUrls => {
  const snapshot = useSyncExternalStore(subscribeCache, () => readCachedUrls(song?.hash ?? null));
  const fetchedRef = useRef<string | null>(null);

  useEffect(() => {
    if (song === null) {
      return (): void => undefined;
    }
    if (urlCache.has(song.hash)) {
      return (): void => undefined;
    }
    if (fetchedRef.current === song.hash) {
      return (): void => undefined;
    }
    fetchedRef.current = song.hash;
    const controller = new AbortController();
    void (async () => {
      try {
        const resolved = await resolveUrls(song);
        if (controller.signal.aborted) {
          return;
        }
        rememberUrls(song.hash, resolved);
        emitCacheChange();
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        throw error;
      }
    })();
    return (): void => {
      controller.abort();
    };
  }, [song]);

  return snapshot;
};

export type PreviewPlayback = {
  isPlaying: boolean;
  hasError: boolean;
  toggle: () => void;
  renderAudioElements: () => ReactNode;
};

export const usePreviewPlayback = (song: PreviewSong | null): PreviewPlayback => {
  const instrumentalRef = useRef<HTMLAudioElement>(null);
  const vocalsRef = useRef<HTMLAudioElement>(null);
  const vocalsBrokenRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [erroredHash, setErroredHash] = useState<string | null>(null);

  const urls = useCachedUrls(song);

  const currentHash = song?.hash ?? null;
  const hasError = erroredHash !== null && erroredHash === currentHash;
  const hasStems = urls.instrumental !== null && urls.vocals !== null;
  const previewUrl = urls.instrumental ?? urls.fallback;

  useEffect(() => {
    const vocals = vocalsRef.current;
    if (vocals === null) {
      return;
    }
    vocals.volume = hasStems && !vocalsBrokenRef.current ? GUIDE_VOCALS_VOLUME : 0;
  }, [hasStems]);

  // Restart playback whenever the active song or its resolved URLs change.
  // The row tap that opened the player counts as the user gesture.
  useEffect(() => {
    const instrumental = instrumentalRef.current;
    const vocals = vocalsRef.current;
    if (song === null || previewUrl === null) {
      return undefined;
    }
    vocalsBrokenRef.current = false;
    if (instrumental !== null) {
      instrumental.pause();
      instrumental.currentTime = 0;
    }
    if (vocals !== null) {
      vocals.pause();
      vocals.currentTime = 0;
    }
    if (instrumental !== null) {
      void instrumental.play().catch(() => {
        setIsPlaying(false);
      });
    }
    if (vocals !== null && hasStems) {
      void vocals.play().catch(() => {
        setIsPlaying(false);
      });
    }
    return () => {
      instrumental?.pause();
      vocals?.pause();
    };
  }, [song, previewUrl, hasStems]);

  const handleEnded = useCallback(() => {
    setIsPlaying(false);
    const vocals = vocalsRef.current;
    if (vocals !== null && !vocals.paused) {
      vocals.pause();
    }
  }, []);

  const handleInstrumentalError = useCallback(() => {
    if (currentHash !== null) {
      setErroredHash(currentHash);
    }
    setIsPlaying(false);
  }, [currentHash]);

  const handleVocalsError = useCallback(() => {
    vocalsBrokenRef.current = true;
    const vocals = vocalsRef.current;
    if (vocals !== null) {
      vocals.pause();
      vocals.volume = 0;
    }
  }, []);

  const handleSeeked = useCallback(() => {
    const instrumental = instrumentalRef.current;
    if (instrumental !== null) {
      syncVocalsToInstrumental(instrumental, vocalsRef.current, hasStems, vocalsBrokenRef.current);
    }
  }, [hasStems]);

  const handleInstrumentalPlay = useCallback(() => {
    setIsPlaying(true);
  }, []);

  const handleInstrumentalPause = useCallback(() => {
    setIsPlaying(false);
  }, []);

  const toggle = useCallback(() => {
    const instrumental = instrumentalRef.current;
    const vocals = vocalsRef.current;
    if (instrumental === null) {
      return;
    }
    if (instrumental.paused) {
      if (vocals !== null && hasStems && !vocalsBrokenRef.current) {
        syncVocalsToInstrumental(instrumental, vocals, hasStems, vocalsBrokenRef.current);
        void vocals.play().catch(() => {
          setIsPlaying(false);
        });
      }
      void instrumental.play().catch(() => {
        setIsPlaying(false);
      });
      return;
    }
    instrumental.pause();
    if (vocals !== null && !vocals.paused) {
      vocals.pause();
    }
  }, [hasStems]);

  const renderAudioElements = useCallback(
    () => (
      <>
        <audio
          ref={instrumentalRef}
          src={previewUrl ?? undefined}
          preload="metadata"
          onPlay={handleInstrumentalPlay}
          onPause={handleInstrumentalPause}
          onSeeked={handleSeeked}
          onError={handleInstrumentalError}
          onEnded={handleEnded}
          className="hidden"
        >
          <track kind="captions" />
        </audio>
        <audio
          ref={vocalsRef}
          src={urls.vocals ?? undefined}
          preload="metadata"
          onError={handleVocalsError}
          onEnded={handleEnded}
          className="hidden"
        >
          <track kind="captions" />
        </audio>
      </>
    ),
    [
      previewUrl,
      urls.vocals,
      handleInstrumentalPlay,
      handleInstrumentalPause,
      handleSeeked,
      handleInstrumentalError,
      handleVocalsError,
      handleEnded,
    ],
  );

  return useMemo(
    () => ({ isPlaying, hasError, toggle, renderAudioElements }),
    [isPlaying, hasError, toggle, renderAudioElements],
  );
};
