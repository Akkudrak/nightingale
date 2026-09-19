import { PlayIcon, SkipForwardIcon, XIcon, YoutubeIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { isTauri } from '@/bridge/runtime';
import { usePlaybackQueueQuery } from '@/features/playback-queue/use-playback-queue';
import type { YouTubeHit } from '@/types/YouTubeHit';

type YouTubePlaybackProps = {
  youtube: YouTubeHit;
  /**
   * `true` when the session was launched from the playback queue (via
   * `useStartNextPlaybackQueueSong`). The visor uses this flag to
   * surface the Skip button and the end-of-video Next overlay.
   * `false` for direct launches from the search results.
   */
  queuePlayback?: boolean;
  /**
   * Handler invoked by the Skip button (mid-video) and the Next-video
   * overlay (when the embed reports `onStateChange: 0`). Wired in
   * `<PlaybackSessionView>` to the same `useStartNextPlaybackQueueSong
   * .playNext` callback that `ResultDialog.onNext` uses for songs.
   */
  onNext?: () => void;
};

/**
 * YouTube iframe API player state. `1` = playing, `0` = ended. Other
 * values (-1 unstarted, 2 paused, 3 buffering, 5 cued) are ignored —
 * we only act on transitions that matter for the visor (autoplay
 * dismiss, end-of-video Next overlay).
 */
const YT_PLAYER_STATE_PLAYING = 1;
const YT_PLAYER_STATE_ENDED = 0;
const YT_POSTMESSAGE_ORIGIN = 'https://www.youtube.com';
const YT_EMBED_BASE = 'https://www.youtube.com/embed/';

/**
 * Build the YouTube embed URL. `playsinline=1` keeps the video inline
 * on mobile WebView flavours, `enablejsapi=1` opts the iframe into our
 * postMessage control channel, `mute=1` lets autoplay work under
 * WebView2's policy, `rel=0` keeps related videos within the same
 * channel.
 */
const buildEmbedUrl = (videoId: string): string =>
  `${YT_EMBED_BASE}${encodeURIComponent(videoId)}?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1&enablejsapi=1`;

type YouTubeStateMessage = {
  readonly event?: unknown;
  readonly info?: unknown;
};

/**
 * Type guard for the YouTube iframe API message envelope.
 * Returns the numeric `info` field when the message is an
 * `onStateChange` event, or `null` otherwise.
 */
const extractStateChangeInfo = (data: unknown): number | null => {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const candidate: YouTubeStateMessage = data;
  if (candidate.event !== 'onStateChange') {
    return null;
  }
  if (typeof candidate.info !== 'number') {
    return null;
  }
  return candidate.info;
};

/**
 * Drive the YouTube iframe via `postMessage` (the official iframe
 * API). `enablejsapi=1` is what allows our parent page to send
 * commands into the iframe; without it the postMessage calls are
 * dropped.
 */
const usePlayerCommands = (
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
): ((func: 'playVideo' | 'unMute') => void) => {
  return useCallback(
    (func) => {
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow) {
        return;
      }
      const message = JSON.stringify({ event: 'command', func, args: '' });
      iframe.contentWindow.postMessage(message, YT_POSTMESSAGE_ORIGIN);
    },
    [iframeRef],
  );
};

/**
 * Wire the global `message` listener that translates YouTube iframe
 * API events into visor state. Bound once on mount; reads the latest
 * `queuePlayback` from a ref so we don't have to re-attach on every
 * prop change.
 */
const useYouTubeStateListener = (
  queuePlaybackRef: React.RefObject<boolean>,
  onPlaying: () => void,
  onEnded: () => void,
): void => {
  useEffect(() => {
    const handler = (event: MessageEvent<unknown>) => {
      if (event.origin !== YT_POSTMESSAGE_ORIGIN) {
        return;
      }
      const info = extractStateChangeInfo(event.data);
      if (info === null) {
        return;
      }
      if (info === YT_PLAYER_STATE_PLAYING) {
        onPlaying();
      } else if (info === YT_PLAYER_STATE_ENDED && queuePlaybackRef.current) {
        onEnded();
      }
    };
    window.addEventListener('message', handler);
    return () => {
      window.removeEventListener('message', handler);
    };
  }, [queuePlaybackRef, onPlaying, onEnded]);
};

/**
 * Autoplay-fallback overlay. WebView2 ships a fresh media-engagement
 * index per webview data directory, so a fresh `<iframe>` can fail
 * autoplay even with `mute=1` until the user clicks once. The click
 * forwards `playVideo` + `unMute` to the iframe via postMessage.
 */
const GestureOverlay = ({ onResume }: { onResume: () => void }) => (
  <button
    type="button"
    onClick={onResume}
    aria-label="Play YouTube video"
    className="absolute inset-0 z-10 flex items-center justify-center bg-black/35 text-white transition-opacity hover:bg-black/45"
  >
    <span className="inline-flex items-center gap-2 rounded-full border border-white/30 bg-black/55 px-5 py-2.5 text-sm font-semibold backdrop-blur-sm">
      <PlayIcon className="size-4 fill-current" aria-hidden="true" />
      Tap to play
    </span>
  </button>
);

/**
 * End-of-video dialog for queued YouTube sessions. Mirrors the song
 * `ResultDialog` — if more entries are queued, offers "Next video";
 * if the queue is empty, falls back to "Exit Playback".
 */
const EndedOverlay = ({
  hasNextEntry,
  videoTitle,
  onNext,
  onExit,
  exitLabel,
}: {
  hasNextEntry: boolean;
  videoTitle: string;
  onNext: () => void;
  onExit: () => void;
  exitLabel: string;
}) => (
  <dialog
    open
    className="absolute inset-0 z-30 flex items-center justify-center bg-black/65 text-white backdrop:bg-black/65"
    aria-label="End of video"
  >
    <div className="flex flex-col items-center gap-3 rounded-lg border border-white/20 bg-black/75 px-6 py-5 shadow-xl backdrop-blur-sm">
      <YoutubeIcon className="size-6" aria-hidden="true" />
      <p className="text-base font-semibold">
        {hasNextEntry ? 'Up next in the queue' : 'End of the queue'}
      </p>
      <p className="line-clamp-1 max-w-xs text-sm text-white/70 [overflow-wrap:anywhere]">
        {videoTitle}
      </p>
      <div className="flex items-center gap-2">
        {hasNextEntry ? (
          <button
            type="button"
            onClick={onNext}
            className="inline-flex items-center gap-2 rounded-md bg-white px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-white/85 active:bg-white/75"
          >
            <SkipForwardIcon className="size-4" aria-hidden="true" />
            Next video
          </button>
        ) : null}
        <button
          type="button"
          onClick={onExit}
          className="inline-flex items-center gap-2 rounded-md border border-white/30 bg-transparent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/10 active:bg-white/20"
        >
          <XIcon className="size-4" aria-hidden="true" />
          {exitLabel}
        </button>
      </div>
    </div>
  </dialog>
);

/**
 * HUD action buttons — Skip (only when there are more queued entries)
 * and Exit (always). Skip mirrors the song `ResultDialog.onNext`
 * path via the `onNext` callback the parent passes in.
 */
const HudButtons = ({
  showSkipButton,
  onSkip,
  onExit,
  skipLabel,
  exitLabel,
}: {
  showSkipButton: boolean;
  onSkip: () => void;
  onExit: () => void;
  skipLabel: string;
  exitLabel: string;
}) => (
  <div className="pointer-events-auto flex shrink-0 items-center gap-2">
    {showSkipButton ? (
      <button
        type="button"
        onClick={onSkip}
        aria-label={skipLabel}
        title={skipLabel}
        className="inline-flex items-center gap-1.5 rounded-md border border-white/30 bg-black/45 px-3 py-1.5 text-sm font-medium text-white/90 backdrop-blur-sm transition-colors hover:bg-black/65 active:bg-black/80"
      >
        <SkipForwardIcon className="size-4" aria-hidden="true" />
        <span className="hidden sm:inline">Skip</span>
      </button>
    ) : null}
    <button
      type="button"
      onClick={onExit}
      aria-label={exitLabel}
      className="inline-flex items-center gap-1.5 rounded-md border border-white/30 bg-black/45 px-3 py-1.5 text-sm font-medium text-white/90 backdrop-blur-sm transition-colors hover:bg-black/65 active:bg-black/80"
    >
      <XIcon className="size-4" aria-hidden="true" />
      {exitLabel}
    </button>
  </div>
);

/**
 * Karaoke visor for YouTube results. Same window shape as the regular
 * playback route, but:
 * - Audio + video come straight from the embedded `<iframe>`. Nightingale
 *   never decodes the stream, never runs the analysis pipeline, never
 *   reads the mic, never scores.
 * - Lyrics display + pitch graph + scoring dialog are intentionally not
 *   mounted: there's no transcript for YouTube videos.
 * - The HUD shows the title/channel, an optional Skip button (when the
 *   session was queue-driven), and an Exit button.
 *
 * Lives in the same `playback` Tauri window (or browser tab on /guest)
 * as the regular karaoke session, so the operator's muscle memory for
 * "play queue → visor pops up" still works.
 */
export const YouTubePlayback = ({
  youtube,
  queuePlayback = false,
  onNext,
}: YouTubePlaybackProps) => {
  const navigate = useNavigate();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // `needsUserGesture` starts true because WebView2 ships with a fresh
  // media-engagement index per webview data directory, so autoplay
  // (even muted) can be blocked on the very first iframe load. We hide
  // the overlay once the user has interacted — either because the
  // autoplay succeeded and the user clicked past our overlay, or
  // because autoplay was blocked and the user clicked the explicit
  // play button.
  const [needsUserGesture, setNeedsUserGesture] = useState(true);
  // `endedPending` flips on when the iframe reports the video finished
  // (`onStateChange: info=0`) and the session is queue-driven. Reset
  // implicitly via the parent component's `key={playbackId}` on every
  // queue advance, so a Next click doesn't leave the overlay stuck
  // from the previous video.
  const [endedPending, setEndedPending] = useState(false);
  // Keep the latest `queuePlayback` value in a ref so the message
  // listener can read it without re-binding on every prop change.
  const queuePlaybackRef = useRef(queuePlayback);
  useEffect(() => {
    queuePlaybackRef.current = queuePlayback;
  }, [queuePlayback]);

  const exitLabel = 'Exit Playback';
  const skipLabel = 'Skip to next video';

  // The playback window subscribes to the same `playback-queue-changed`
  // broadcast as the library, so this query stays in sync with removes
  // / clears performed in the main window while the iframe is playing.
  const { data: queueEntries = [] } = usePlaybackQueueQuery();
  const hasNextEntry = queuePlayback && queueEntries.length > 0;
  const showSkipButton = queuePlayback && hasNextEntry;
  const showEndedOverlay = queuePlayback && endedPending;

  const handleExit = useCallback(() => {
    if (isTauri) {
      // Tauri desktop: close the playback webview window so the user
      // returns to the library. `window.close()` on a Tauri webview
      // hits the `tauri://close-requested` handler and is allowed for
      // any window the renderer opened.
      window.close();
      return;
    }
    // /guest browser tab: navigate back to the guest root so closing
    // the tab doesn't strand the user on an empty playback route.
    void navigate('/');
  }, [navigate]);

  const sendPlayerCommand = usePlayerCommands(iframeRef);

  const dismissGestureOverlay = useCallback(() => {
    setNeedsUserGesture(false);
  }, []);

  const handleResume = useCallback(() => {
    // The click is the user gesture that WebView2 / Chromium need to
    // grant autoplay. We forward `playVideo` + `unMute` so the user
    // sees the video with audio — `mute=1` in the embed URL is just a
    // belt-and-suspenders for the autoplay-on-load path; this click
    // gives us a guaranteed moment to undo it.
    dismissGestureOverlay();
    sendPlayerCommand('unMute');
    sendPlayerCommand('playVideo');
  }, [dismissGestureOverlay, sendPlayerCommand]);

  const handleEndedNext = useCallback(() => {
    setEndedPending(false);
    onNext?.();
  }, [onNext]);

  const handleSkip = useCallback(() => {
    onNext?.();
  }, [onNext]);

  useYouTubeStateListener(queuePlaybackRef, dismissGestureOverlay, () => setEndedPending(true));

  const embedUrl = buildEmbedUrl(youtube.video_id);

  return (
    <div className="fixed inset-0 overflow-hidden bg-black" style={{ contain: 'strict' }}>
      {/* oxlint-disable-next-line iframe-missing-sandbox -- YouTube's
       * iframe API needs the iframe's effective origin to be
       * `https://www.youtube.com` (not the opaque origin a sandbox
       * would impose) so the player can persist volume / quality
       * preferences and respond to our postMessage commands. */}
      <iframe
        key={youtube.video_id}
        ref={iframeRef}
        title={`YouTube video: ${youtube.title}`}
        src={embedUrl}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        className="absolute inset-0 h-full w-full border-0"
      />

      {needsUserGesture ? <GestureOverlay onResume={handleResume} /> : null}

      {showEndedOverlay ? (
        <EndedOverlay
          hasNextEntry={hasNextEntry}
          videoTitle={youtube.title}
          onNext={handleEndedNext}
          onExit={handleExit}
          exitLabel={exitLabel}
        />
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-3 md:p-4">
        <div className="pointer-events-auto flex min-w-0 max-w-[60%] flex-col gap-1 rounded-md bg-black/45 px-3 py-2 backdrop-blur-sm">
          <div className="flex items-center gap-2 text-[0.65rem] font-semibold uppercase tracking-wider text-white/70">
            <YoutubeIcon className="size-3.5" aria-hidden="true" />
            YouTube Preview
          </div>
          <h1 className="line-clamp-2 [overflow-wrap:anywhere] text-base leading-tight text-white md:text-[1.25rem]">
            {youtube.title}
          </h1>
          <p className="line-clamp-1 [overflow-wrap:anywhere] text-sm text-white/70 md:text-base">
            {youtube.channel_title}
          </p>
        </div>

        <HudButtons
          showSkipButton={showSkipButton}
          onSkip={handleSkip}
          onExit={handleExit}
          skipLabel={skipLabel}
          exitLabel={exitLabel}
        />
      </div>
    </div>
  );
};
