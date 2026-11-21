/**
 * List of caches from the catalog (manifest + security header) for the catalog
 * API. Doesn't download full content. Manifest display fields are sanitized
 * (control chars stripped, length capped): they reach the UI, and a shared
 * cache can carry social-engineering text in name/description.
 */

import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { sanitizeDisplayText } from "./CacheInjectionScanner.js";

export interface CatalogCacheItem {
  cache_id: string;
  name: string;
  description: string | null;
  domain: string | null;
  language: string | null;
  author: string | null;
  signed: boolean;
  file_name: string;
  /** true when the file lives in the quarantine (untrusted/) subdirectory. */
  quarantined?: boolean;
}

const MANIFEST_ENTRY_MAX = 64 * 1024;

/**
 * Only reads manifest.json (+ signature presence) from .claw-cache (ZIP).
 * Returns null on error.
 */
async function readManifestFromFile(
  filePath: string
): Promise<Omit<CatalogCacheItem, "file_name" | "quarantined"> | null> {
  try {
    const buf = await readFile(filePath, { signal: AbortSignal.timeout(5000) });
    if (buf.length > 8 * 1024 * 1024) return null;
    const zip = await JSZip.loadAsync(buf);
    const entry = zip.file("manifest.json");
    if (!entry) return null;
    const entryMeta = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
    if (typeof entryMeta?.uncompressedSize === "number" && entryMeta.uncompressedSize > MANIFEST_ENTRY_MAX) {
      return null;
    }
    const raw = await entry.async("string");
    if (Buffer.byteLength(raw, "utf8") > MANIFEST_ENTRY_MAX) return null;
    const manifest = JSON.parse(raw) as {
      cache_id?: string;
      name?: string;
      description?: string;
      domain?: string;
      language?: string;
      author?: string;
    };
    if (typeof manifest.cache_id !== "string" || !manifest.cache_id.trim()) return null;
    return {
      cache_id: manifest.cache_id.trim().slice(0, 128),
      name: sanitizeDisplayText(manifest.name) || sanitizeDisplayText(manifest.cache_id, 128),
      description: sanitizeDisplayText(manifest.description) || null,
      domain: sanitizeDisplayText(manifest.domain, 100) || null,
      language: sanitizeDisplayText(manifest.language, 32) || null,
      author: sanitizeDisplayText(manifest.author, 120) || null,
      signed: !!zip.file("security/signature.sig"),
    };
  } catch {
    return null;
  }
}

/**
 * Returns a list of caches from the storePath directory (*.claw-cache files,
 * non-recursive). If there is an error reading the directory, the array is empty.
 */
export async function listCachesFromDir(
  storePath: string | null | undefined,
  options: { quarantined?: boolean } = {}
): Promise<CatalogCacheItem[]> {
  if (!storePath || typeof storePath !== "string") return [];
  const dir = resolve(options.quarantined ? join(resolve(storePath), "untrusted") : resolve(storePath));
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
      ...manifest,
      file_name: name,
      quarantined: options.quarantined ? true : undefined,
    });
  }
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

/**
 * Quarantined caches: files under {storePath}/untrusted/. They never activate
 * until explicitly accepted (see catalog-manage.acceptQuarantinedCache).
 */
export async function listQuarantinedCaches(storePath: string | null | undefined): Promise<CatalogCacheItem[]> {
  return listCachesFromDir(storePath, { quarantined: true });
}
