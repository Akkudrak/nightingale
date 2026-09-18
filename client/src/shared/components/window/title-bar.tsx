import { useQueryClient } from '@tanstack/react-query';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { MinusIcon, SquareIcon, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { loadConfig, saveConfig } from '@/bridge/config';
import { onDeepLinkImportDone } from '@/bridge/deep-link';
import { isFullScreen as tauriIsFullScreen, setFullScreen } from '@/bridge/fullScreen';
import { isSessionPlayback } from '@/bridge/playback-session';
import { isTauri } from '@/bridge/runtime';
import { minimizeWindow, triggerFrontendReady, windowImmersive } from '@/bridge/window';
import { SONGS } from '@/shared/query-keys';

export function TauriAppShell({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    void triggerFrontendReady();
  }, []);

  useEffect(() => {
    if (!isTauri) {
      return undefined;
    }

    const toggleFullscreen = async (): Promise<void> => {
      const [current, config] = await Promise.all([tauriIsFullScreen(), loadConfig()]);
      const next = !current;
      await Promise.all([setFullScreen(next), saveConfig({ ...config, fullscreen: next })]);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'F11') {
        return;
      }
      event.preventDefault();
      void toggleFullscreen();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Subscribe to deep-link imports. The Rust handler in
  // `client/src-tauri/src/deep_link.rs` downloads the bundle, runs the
  // import pipeline, and emits a single `deep-link-import-done` event
  // — we surface the result here so the user gets feedback regardless
  // of which page they're on in the SPA.
  useDeepLinkImportListener();

  if (!isTauri) {
    return children;
  }

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  );
}

function TitleBar() {
  const [fullscreen, setFullscreen] = useState(false);
  const sessionPlayback = isSessionPlayback();

  useEffect(() => {
    const win = getCurrentWindow();

    const sync = async () => {
      setFullscreen(await windowImmersive());
    };

    void sync();

    let unlistenResize: (() => void) | undefined;
    let unlistenFocus: (() => void) | undefined;

    void win
      .onResized(() => {
        void sync();
      })
      .then((fn) => {
        unlistenResize = fn;
        return undefined;
      });

    void win
      .onFocusChanged(() => {
        void sync();
      })
      .then((fn) => {
        unlistenFocus = fn;
        return undefined;
      });

    return () => {
      unlistenResize?.();
      unlistenFocus?.();
    };
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--titlebar-offset',
      fullscreen || sessionPlayback ? '0px' : '2rem',
    );

    return () => {
      document.documentElement.style.removeProperty('--titlebar-offset');
    };
  }, [fullscreen, sessionPlayback]);

  if (fullscreen) {
    return null;
  }

  const win = getCurrentWindow();

  if (sessionPlayback) {
    return (
      <div className="fixed right-2 top-2 z-50 flex h-8 items-center overflow-hidden rounded-md border border-border bg-background/85 shadow-md backdrop-blur-sm">
        <div
          className="h-full w-12 cursor-move border-r border-border"
          aria-hidden
          title="Drag playback window"
          onMouseDown={() => void win.startDragging()}
        />
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          aria-label="Minimize"
          onClick={() => void minimizeWindow()}
        >
          <MinusIcon className="size-3.5" strokeWidth={2} />
        </button>
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          aria-label="Maximize"
          onClick={() => void win.toggleMaximize()}
        >
          <SquareIcon className="size-3" strokeWidth={2} />
        </button>
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
          aria-label="Close"
          onClick={() => void win.close()}
        >
          <XIcon className="size-3.5" strokeWidth={2} />
        </button>
      </div>
    );
  }

  return (
    <header className="flex h-8 shrink-0 select-none items-stretch border-b border-border bg-background">
      <div
        className="min-h-0 min-w-0 flex-1"
        aria-hidden
        onMouseDown={() => void win.startDragging()}
      />
      <div className="flex items-center gap-0.5 pl-1 pr-1.5">
        <button
          type="button"
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          aria-label="Minimize"
          onClick={() => void minimizeWindow()}
        >
          <MinusIcon className="size-3.5" strokeWidth={2} />
        </button>
        <button
          type="button"
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          aria-label="Maximize"
          onClick={() => void win.toggleMaximize()}
        >
          <SquareIcon className="size-3" strokeWidth={2} />
        </button>
        <button
          type="button"
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
          aria-label="Close"
          onClick={() => void win.close()}
        >
          <XIcon className="size-3.5" strokeWidth={2} />
        </button>
      </div>
    </header>
  );
}

/**
 * Subscribes to the Rust-side `deep-link-import-done` event and toasts
 * the result. Lives in `TauriAppShell` so it mounts only when the
 * desktop app is running (the web admin has no deep-link emitter).
 *
 * On success: success toast + invalidate the `SONGS` query so the
 * library view refetches. On failure: error toast with the message
 * surfaced from the Rust handler.
 */
function useDeepLinkImportListener(): null {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isTauri) {
      return undefined;
    }

    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void onDeepLinkImportDone((payload) => {
      if (cancelled) {
        return;
      }
      if (payload.ok) {
        const title = payload.title ?? 'Unknown title';
        const artist = payload.artist ?? 'Unknown artist';
        toast.success(`Imported "${title}" by ${artist}`);
        void queryClient.invalidateQueries({ queryKey: SONGS });
      } else {
        toast.error(`Couldn't import from deep link: ${payload.error ?? 'unknown error'}`);
      }
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
      return undefined;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [queryClient]);

  return null;
}
