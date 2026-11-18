/**
 * List of caches from the catalog (manifest only) for the catalog API. Doesn't download full content.
 */

import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";

export interface CatalogCacheItem {
  cache_id: string;
  name: string;
  description: string | null;
  domain: string | null;
  language: string | null;
  file_name: string;
}

/**
 * Only reads manifest.json from .claw-cache (ZIP). Returns null on error.
 */
async function readManifestFromFile(filePath: string): Promise<{ cache_id: string; name?: string; description?: string; domain?: string; language?: string } | null> {
  try {
    const buf = await readFile(filePath, { signal: AbortSignal.timeout(5000) });
    const zip = await JSZip.loadAsync(buf);
    const entry = zip.file("manifest.json");
    if (!entry) return null;
    const raw = await entry.async("string");
    const manifest = JSON.parse(raw) as { cache_id?: string; name?: string; description?: string; domain?: string; language?: string };
    if (typeof manifest.cache_id !== "string" || !manifest.cache_id.trim()) return null;
    return {
      cache_id: manifest.cache_id.trim(),
      name: typeof manifest.name === "string" ? manifest.name : manifest.cache_id,
      description: typeof manifest.description === "string" ? manifest.description : undefined,
      domain: typeof manifest.domain === "string" ? manifest.domain : undefined,
      language: typeof manifest.language === "string" ? manifest.language : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Returns a list of caches from the storePath directory (*.claw-cache files). If there is an error reading the directory, the array is empty.
 */
export async function listCachesFromDir(storePath: string | null | undefined): Promise<CatalogCacheItem[]> {
  if (!storePath || typeof storePath !== "string") return [];
  const dir = resolve(storePath);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const results: CatalogCacheItem[] = [];
  for (const name of entries) {
    if (!name.endsWith(".claw-cache")) continue;
    const filePath = join(dir, name);
    const manifest = await readManifestFromFile(filePath);
    if (!manifest) continue;
    results.push({
      cache_id: manifest.cache_id,
      name: manifest.name ?? manifest.cache_id,
      description: manifest.description ?? null,
      domain: manifest.domain ?? null,
      language: manifest.language ?? null,
      file_name: name,
    });
  }
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}
