// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

export interface FileGrant {
  k: string;
  exp: number;
}

/** Reset detaches all outstanding requests from the current session. */
export function createFileGrantCache(load: (path: string) => Promise<FileGrant>) {
  const grants = new Map<string, FileGrant>();
  const pending = new Map<string, Promise<FileGrant | null>>();
  const listeners = new Set<() => void>();
  let revision = 0;
  const notify = () => {
    revision++;
    for (const listener of listeners) listener();
  };
  const peek = (path: string) => {
    const grant = grants.get(path);
    return grant && grant.exp > Date.now() ? grant : null;
  };
  return {
    peek,
    get(path: string): Promise<FileGrant | null> {
      const cached = peek(path);
      if (cached && cached.exp - Date.now() > 30_000) return Promise.resolve(cached);
      const existing = pending.get(path);
      if (existing) return existing;
      const request = Promise.resolve().then(() => load(path)).then((grant) => {
        if (pending.get(path) !== request) return null;
        if (grants.size >= 512 && !grants.has(path)) {
          const first = grants.keys().next().value;
          if (first !== undefined) grants.delete(first);
        }
        grants.set(path, grant);
        notify();
        return grant;
      }).catch(() => null).finally(() => {
        if (pending.get(path) === request) pending.delete(path);
      });
      pending.set(path, request);
      return request;
    },
    clear(): void {
      grants.clear();
      pending.clear();
      notify();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    snapshot: () => revision,
  };
}
