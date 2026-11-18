import { apiBase } from "../config";
import { getAuthHeaders } from "../auth/storage";

export interface CatalogCache {
  cache_id: string;
  name: string;
  description: string | null;
  domain: string | null;
  language: string | null;
  file_name: string;
}

export interface CatalogCachesResponse {
  caches: CatalogCache[];
}

async function readError(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  return (data as { error?: string }).error || `HTTP ${res.status}`;
}

export async function getCatalogCaches(): Promise<CatalogCache[]> {
  const res = await fetch(`${apiBase}/api/catalog/caches`, {
    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
  });
  if (res.status === 401) throw new Error("auth_required");
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as CatalogCachesResponse;
  return data.caches ?? [];
}

/** Copy a local .claw-cache into cacheStorePath. */
export async function importCatalogCache(sourcePath: string): Promise<CatalogCache> {
  const res = await fetch(`${apiBase}/api/catalog/caches/import`, {
    method: "POST",
    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ sourcePath }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as { cache: CatalogCache };
  return data.cache;
}

/** Rename the display name (manifest.name). */
export async function renameCatalogCache(fileName: string, name: string): Promise<CatalogCache> {
  const res = await fetch(`${apiBase}/api/catalog/caches`, {
    method: "PATCH",
    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ file_name: fileName, name }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as { cache: CatalogCache };
  return data.cache;
}

/** Delete a cache file from the directory. */
export async function deleteCatalogCache(fileName: string): Promise<void> {
  const res = await fetch(`${apiBase}/api/catalog/caches`, {
    method: "DELETE",
    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ file_name: fileName }),
  });
  if (!res.ok) throw new Error(await readError(res));
}
