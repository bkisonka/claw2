// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { apiBase, apiKey } from "../config";
import { getAuthHeaders } from "../auth/storage";

export interface CatalogCache {
  cache_id: string;
  name: string;
  description: string | null;
  domain: string | null;
  language: string | null;
  author: string | null;
  signed: boolean;
  file_name: string;
  quarantined?: boolean;
}

export interface CatalogCacheScan {
  passedInjectionScan: boolean;
  integrity: string;
  signed: boolean;
  warnings: string[];
  injectionIssues: number;
}

export interface CatalogCachesResponse {
  caches: CatalogCache[];
  quarantined: CatalogCache[];
}

async function readError(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  return (data as { error?: string }).error || `HTTP ${res.status}`;
}

export async function getCatalogCaches(): Promise<CatalogCachesResponse> {
  const res = await fetch(`${apiBase}/api/catalog/caches`, {
    headers: { "Content-Type": "application/json", ...(apiKey ? { "X-API-Key": apiKey, Authorization: `Bearer ${apiKey}` } : {}), ...getAuthHeaders() },
  });
  if (res.status === 401) throw new Error("auth_required");
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as Partial<CatalogCachesResponse>;
  return { caches: data.caches ?? [], quarantined: data.quarantined ?? [] };
}

/**
 * Import a local .claw-cache. Foreign caches always land in the quarantine
 * (untrusted/) and never activate automatically.
 */
export async function importCatalogCache(
  sourcePath: string
): Promise<{ cache: CatalogCache; scan: CatalogCacheScan }> {
  const res = await fetch(`${apiBase}/api/catalog/caches/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey ? { "X-API-Key": apiKey, Authorization: `Bearer ${apiKey}` } : {}), ...getAuthHeaders() },
    body: JSON.stringify({ sourcePath }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as { cache: CatalogCache; scan: CatalogCacheScan };
  return { cache: data.cache, scan: data.scan };
}

/** Explicitly accept a quarantined cache (moves it into the active store). */
export async function acceptCatalogCache(fileName: string): Promise<CatalogCache> {
  const res = await fetch(`${apiBase}/api/catalog/caches/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey ? { "X-API-Key": apiKey, Authorization: `Bearer ${apiKey}` } : {}), ...getAuthHeaders() },
    body: JSON.stringify({ file_name: fileName }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as { cache: CatalogCache };
  return data.cache;
}

/** Rename the display name (manifest.name). */
export async function renameCatalogCache(fileName: string, name: string): Promise<CatalogCache> {
  const res = await fetch(`${apiBase}/api/catalog/caches`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(apiKey ? { "X-API-Key": apiKey, Authorization: `Bearer ${apiKey}` } : {}), ...getAuthHeaders() },
    body: JSON.stringify({ file_name: fileName, name }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as { cache: CatalogCache };
  return data.cache;
}

/** Delete a cache file from the store or quarantine directory. */
export async function deleteCatalogCache(fileName: string): Promise<void> {
  const res = await fetch(`${apiBase}/api/catalog/caches`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...(apiKey ? { "X-API-Key": apiKey, Authorization: `Bearer ${apiKey}` } : {}), ...getAuthHeaders() },
    body: JSON.stringify({ file_name: fileName }),
  });
  if (!res.ok) throw new Error(await readError(res));
}
