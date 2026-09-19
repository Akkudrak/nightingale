import { ExternalLinkIcon, ListPlusIcon, YoutubeIcon } from 'lucide-react';
import { useId } from 'react';
import { toast } from 'sonner';

import {
  reservePlaybackTarget,
  savePlaybackSession,
  showPlaybackTarget,
} from '@/bridge/playback-session';
import { isTauri } from '@/bridge/runtime';
import { useAddPlaybackQueueEntry } from '@/features/playback-queue/use-playback-queue';
import { Button } from '@/shared/components/ui/button';
import type { YouTubeHit } from '@/types/YouTubeHit';

type YouTubeSeparatorProps = {
  visible: boolean;
};

export const YouTubeSeparator = ({ visible }: YouTubeSeparatorProps) => {
  if (!visible) {
    return null;
  }
  return (
    <div
      className="mt-4 flex items-center gap-3 border-b border-dashed border-foreground/30 px-2 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
      aria-label="From YouTube"
    >
      <YoutubeIcon className="size-4" aria-hidden="true" />
      <span>From YouTube</span>
    </div>
  );
};

type YouTubeResultsListProps = {
  hits: YouTubeHit[];
  loading: boolean;
};

export const YouTubeResultsList = ({ hits, loading }: YouTubeResultsListProps) => {
  if (hits.length === 0) {
    if (!loading) {
      return null;
    }
    return (
      <div
        className="flex flex-col items-center gap-2 px-3 py-6 text-sm text-muted-foreground"
        aria-live="polite"
      >
        <YoutubeIcon className="size-5" aria-hidden="true" />
        Searching YouTube…
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-2 p-2" aria-label="YouTube search results">
      {hits.map((hit) => (
        <YouTubeResultRow key={hit.video_id} hit={hit} />
      ))}
    </ul>
  );
};

const openInBrowser = async (url: string): Promise<void> => {
  if (isTauri) {
    const { openUrl: openTauriUrl } = await import('@tauri-apps/plugin-opener');
    await openTauriUrl(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
};

const launchInVisor = async (hit: YouTubeHit): Promise<void> => {
  // Same dance `usePlaybackLauncher` does for local songs: reserve a
  // target (a browser tab on /guest, nothing extra on Tauri), persist
  // the session payload, then show the target so the karaoke visor
  // route picks it up.
  const target = isTauri ? null : reservePlaybackTarget();
  if (!isTauri && target === undefined) {
    toast.error('Allow pop-ups to open the playback tab');
    return;
  }

  try {
    // `queuePlayback: false` — direct search-result launches skip the
    // queue pipeline, so the visor must NOT surface Skip / Next-video
    // affordances. Queue-driven launches set this to `true` inside
    // `useStartNextPlaybackQueueSong`.
    await savePlaybackSession({ kind: 'youtube', youtube: hit, queuePlayback: false });
    await showPlaybackTarget(target);
  } catch (error) {
    target?.close();
    toast.error(
      `Could not start YouTube playback: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const YouTubeResultRow = ({ hit }: { hit: YouTubeHit }) => {
  const titleId = useId();
  const { mutate: addToQueue, isPending: adding } = useAddPlaybackQueueEntry();
  return (
    <li>
      <div className="group flex w-full items-stretch gap-1 rounded-md hover:bg-muted/60">
        <Button
          variant="ghost"
          className="h-auto min-w-0 flex-1 justify-start gap-3 rounded-md px-3 py-2 text-left"
          onClick={() => {
            void launchInVisor(hit);
          }}
          aria-labelledby={titleId}
        >
          <img
            src={hit.thumbnail_url}
            alt=""
            loading="lazy"
            className="size-16 shrink-0 rounded-sm object-cover"
            width={64}
            height={48}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span id={titleId} className="line-clamp-2 text-sm font-medium text-foreground">
              {hit.title}
            </span>
            <span className="line-clamp-1 text-xs text-muted-foreground">{hit.channel_title}</span>
          </div>
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={adding}
          onClick={() => addToQueue({ kind: 'youtube', youtube: hit })}
          aria-label={`Add “${hit.title}” to playback queue`}
          title="Add to queue"
          className="shrink-0 self-stretch"
        >
          <ListPlusIcon className="size-4" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            void openInBrowser(hit.watch_url);
          }}
          aria-label={`Open “${hit.title}” in browser`}
          title="Open in browser"
          className="shrink-0 self-stretch"
        >
          <ExternalLinkIcon className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </li>
  );
};
