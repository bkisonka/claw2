/**
 * Local storage of downloaded caches. Deduplication by cache_id.
 */

import type { ClawCacheContent } from "./types.js";

const store = new Map<string, ClawCacheContent>();

export function getCached(cacheId: string): ClawCacheContent | undefined {
  return store.get(cacheId);
}

export function setCached(content: ClawCacheContent): void {
  store.set(content.manifest.cache_id, content);
}

export function clearCached(cacheId: string): boolean {
  return store.delete(cacheId);
}
