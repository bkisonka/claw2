// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

export interface BoundedIdleStoreOptions {
  maxEntries: number;
  idleTtlMs: number;
  now?: () => number;
}

interface StoredValue<T> {
  value: T;
  lastAccessedAt: number;
}

/** Small process-local store with idle expiry and least-recently-accessed eviction. */
export class BoundedIdleStore<K, V> {
  private readonly entries = new Map<K, StoredValue<V>>();
  private readonly now: () => number;

  constructor(private readonly options: BoundedIdleStoreOptions) {
    if (options.maxEntries < 1) throw new Error("maxEntries must be positive");
    if (options.idleTtlMs < 1) throw new Error("idleTtlMs must be positive");
    this.now = options.now ?? Date.now;
  }

  get(key: K): V | undefined {
    const now = this.now();
    this.pruneExpired(now);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    entry.lastAccessedAt = now;
    return entry.value;
  }

  set(key: K, value: V): void {
    const now = this.now();
    this.pruneExpired(now);
    this.entries.delete(key);
    while (this.entries.size >= this.options.maxEntries) {
      this.evictLeastRecentlyAccessed();
    }
    this.entries.set(key, { value, lastAccessedAt: now });
  }

  deleteWhere(predicate: (key: K) => boolean): number {
    let deleted = 0;
    for (const key of this.entries.keys()) {
      if (predicate(key) && this.entries.delete(key)) deleted += 1;
    }
    return deleted;
  }

  /** Test visibility without exposing stored HSS node values. */
  get size(): number {
    this.pruneExpired(this.now());
    return this.entries.size;
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.lastAccessedAt >= this.options.idleTtlMs) {
        this.entries.delete(key);
      }
    }
  }

  private evictLeastRecentlyAccessed(): void {
    let oldestKey: K | undefined;
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.entries) {
      if (entry.lastAccessedAt < oldestAccess) {
        oldestKey = key;
        oldestAccess = entry.lastAccessedAt;
      }
    }
    if (oldestKey !== undefined) this.entries.delete(oldestKey);
  }
}
