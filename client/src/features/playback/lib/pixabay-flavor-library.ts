import type { VideoFlavor } from './video-flavor';

function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];

  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy;
}

/**
 * In-memory store of Pixabay video URLs per flavor.
 *
 * - The "pool" is the canonical, deduped set of URLs known for a flavor.
 * - The "queue" is a shuffled play order drawn from the pool; once exhausted,
 *   `pullUrl(flavor, allowFallback=true)` falls back to a round-robin over the
 *   pool so playback never stalls while we're waiting for more downloads.
 * - The "ready" set tracks URLs whose <video> element has fired `canplay`,
 *   so the rotator can prefer slots that won't visibly stall.
 *
 * The `'custom'` flavor is treated differently: the user drops their own
 * `.mp4` files into `<cache>/videos/custom/`, and the rotator picks ONE
 * video at random from the pool on first pull and loops it forever. The
 * Pixabay FIFO queue and the round-robin fallback are bypassed entirely.
 * See `customPickByFlavor` below.
 */
function pullKnownUrl(queue: string[], known: ReadonlySet<string>): string | null {
  while (queue.length > 0) {
    const next = queue.shift() ?? '';
    if (next !== '' && known.has(next)) {
      return next;
    }
  }

  return null;
}

export class PixabayFlavorLibrary {
  private readonly poolByFlavor = new Map<VideoFlavor, string[]>();
  private readonly queueByFlavor = new Map<VideoFlavor, string[]>();
  private readonly fallbackIndexByFlavor = new Map<VideoFlavor, number>();
  private readonly readyUrls = new Set<string>();
  /**
   * For the `'custom'` flavor only: remembers the single URL we picked
   * from the pool so subsequent pulls return the same one and the
   * `<video loop>` element keeps rewinding it. Reset by `registerUrls`
   * (folder change → re-pick) and by `removeUrl` (the picked file was
   * evicted).
   */
  private readonly customPickByFlavor = new Map<VideoFlavor, string | null>();

  registerUrls(flavor: VideoFlavor, urls: readonly string[]): void {
    if (urls.length === 0) {
      return;
    }

    const existingPool = this.poolByFlavor.get(flavor) ?? [];
    const known = new Set(existingPool);
    const fresh = urls.filter((url) => !known.has(url));
    if (fresh.length === 0) {
      return;
    }

    this.poolByFlavor.set(flavor, [...existingPool, ...fresh]);

    if (flavor === 'custom') {
      // The folder contents changed (or we just learned about it).
      // Drop the current pick so the next `pullUrl` reshuffles and
      // picks a fresh random URL.
      this.customPickByFlavor.set(flavor, null);
      return;
    }

    const queue = this.queueByFlavor.get(flavor) ?? [];
    this.queueByFlavor.set(flavor, [...queue, ...shuffled(fresh)]);
  }

  removeUrl(flavor: VideoFlavor, url: string): void {
    const pool = this.poolByFlavor.get(flavor) ?? [];
    this.poolByFlavor.set(
      flavor,
      pool.filter((u) => u !== url),
    );

    const queue = this.queueByFlavor.get(flavor) ?? [];
    this.queueByFlavor.set(
      flavor,
      queue.filter((u) => u !== url),
    );

    if (flavor === 'custom' && this.customPickByFlavor.get(flavor) === url) {
      // The video we were looping got evicted (folder change).
      // Next pullUrl will reshuffle from the remaining pool.
      this.customPickByFlavor.set(flavor, null);
    }

    this.readyUrls.delete(url);
  }

  pullUrl(flavor: VideoFlavor, allowFallback: boolean): string | null {
    if (flavor === 'custom') {
      return this.pullCustomUrl(flavor);
    }

    const queue = this.queueByFlavor.get(flavor) ?? [];
    const known = new Set(this.poolByFlavor.get(flavor) ?? []);

    const queued = pullKnownUrl(queue, known);
    this.queueByFlavor.set(flavor, queue);
    if (queued !== null) {
      return queued;
    }

    if (!allowFallback) {
      return null;
    }

    const pool = this.poolByFlavor.get(flavor) ?? [];
    if (pool.length === 0) {
      return null;
    }

    const index = this.fallbackIndexByFlavor.get(flavor) ?? 0;
    this.fallbackIndexByFlavor.set(flavor, index + 1);

    return pool[index % pool.length];
  }

  queueLength(flavor: VideoFlavor): number {
    if (flavor === 'custom') {
      // Report "1" once a pick exists so `handleEnded`'s refresh check
      // (`if (queueLength < MIN_QUEUE_BEFORE_REFRESH) refresh()`) quiets
      // down — we don't need a Pixabay fetch while the user is happily
      // looping their own file.
      const pick = this.customPickByFlavor.get(flavor) ?? null;
      const pool = this.poolByFlavor.get(flavor) ?? [];
      return pick !== null && pool.includes(pick) ? 1 : 0;
    }
    return this.queueByFlavor.get(flavor)?.length ?? 0;
  }

  /**
   * The `'custom'` flavor's pullUrl branch, extracted so the main
   * `pullUrl` body stays under oxlint's complexity cap (the Pixabay
   * FIFO path below has its own branches to count).
   *
   * The `<video loop>` element handles the rewind; the slot rotator
   * only needs ONE URL per session. Persist the pick so consecutive
   * calls keep returning the same URL, and so refreshing the slot's
   * `src` (via `setSlotSrc`) doesn't change which video is playing.
   */
  private pullCustomUrl(flavor: VideoFlavor): string | null {
    const pick = this.customPickByFlavor.get(flavor) ?? null;
    const pool = this.poolByFlavor.get(flavor) ?? [];
    if (pick !== null && pool.includes(pick)) {
      return pick;
    }
    if (pool.length === 0) {
      return null;
    }
    const choice = pool[Math.floor(Math.random() * pool.length)];
    this.customPickByFlavor.set(flavor, choice);
    return choice;
  }

  markReady(url: string): void {
    this.readyUrls.add(url);
  }

  markUnready(url: string): void {
    this.readyUrls.delete(url);
  }

  isReady(url: string): boolean {
    return this.readyUrls.has(url);
  }
}
