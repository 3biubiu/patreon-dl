/**
 * Lists a visitor has already seen, kept so that going back to one does not
 * fetch it a second time.
 *
 * Entries are keyed by `location.key`, which identifies one history entry, and
 * carry a signature of the parameters they were fetched with. A back
 * navigation lands on the same key with the same parameters and can therefore
 * reuse the data outright; anything else - a new page, a changed filter, a
 * different page size - produces a different key or signature and falls
 * through to a real request.
 *
 * The cache lives for as long as the tab does. Reloading the page is what
 * picks up content downloaded in the meantime.
 */

interface CachedView<T> {
  signature: string;
  data: T;
}

/** Enough for a browsing session's worth of back-and-forth, bounded so a long one cannot grow without limit. */
const MAX_ENTRIES = 20;

const cache = new Map<string, CachedView<unknown>>();

export function readViewCache<T>(key: string): CachedView<T> | undefined {
  return cache.get(key) as CachedView<T> | undefined;
}

export function writeViewCache<T>(key: string, signature: string, data: T) {
  // Re-inserting moves the entry to the end, so `Map`'s insertion order is a
  // least-recently-written list and the first key is the one to drop.
  cache.delete(key);
  cache.set(key, { signature, data });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
}
