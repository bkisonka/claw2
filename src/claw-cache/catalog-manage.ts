// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Managing activation cache directory files (import / accept / rename / delete).
 *
 * Sharing model: an imported (foreign) cache always lands in the quarantine
 * subdirectory {storePath}/untrusted/ — never in the active store. Moving it
 * into the store is a separate explicit action (acceptQuarantinedCache) that
 * requires the cache to pass the full load-time validation (integrity,
 * signature, injection scan).
 */

import { access, copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import JSZip from "jszip";
import { listCachesFromDir, listQuarantinedCaches, type CatalogCacheItem } from "./list-catalog.js";
import { loadCacheFromPath } from "./CacheLoader.js";
import { clearCacheKeyPin } from "./cache-signature.js";
import { sanitizeDisplayText } from "./CacheInjectionScanner.js";

export function safeCacheFileName(name: string): string | null {
  const base = basename(String(name ?? "").trim());
  if (!base || base.includes("..") || !base.endsWith(".claw-cache")) return null;
  if (base !== String(name ?? "").trim().replace(/^.*[/\\]/, "")) return null;
  return base;
}

function resolveUnderStore(storePath: string, fileName: string, subdir?: "untrusted"): string | null {
  const safe = safeCacheFileName(fileName);
  if (!safe) return null;
  const dir = resolve(subdir ? join(resolve(storePath), subdir) : resolve(storePath));
  const full = resolve(dir, safe);
  const rel = relative(dir, full);
  if (!rel || rel.startsWith("..") || rel.includes("..")) return null;
  return full;
}

async function uniqueDestName(storePath: string, preferred: string): Promise<string> {
  const dir = resolve(storePath);
  const base = safeCacheFileName(preferred) ?? "import.claw-cache";
  const stem = base.replace(/\.claw-cache$/i, "");
  let candidate = `${stem}.claw-cache`;
  let i = 0;
  for (;;) {
    try {
      await access(join(dir, candidate));
      i += 1;
      candidate = `${stem}-${i}.claw-cache`;
    } catch {
      return candidate;
    }
  }
}

export interface ImportCacheResult {
  /** Item as visible in the (quarantined) catalog. */
  cache: CatalogCacheItem;
  quarantined: true;
  /** Why the file was quarantined or kept, from the load-time scan. */
  scan: {
    passedInjectionScan: boolean;
    integrity: string;
    signed: boolean;
    warnings: string[];
    injectionIssues: number;
  };
}

/**
 * Copies a foreign .claw-cache into the quarantine {storePath}/untrusted/.
 * The file must at least be a loadable archive (manifest present, integrity
 * and signature valid when present) — a broken/tampered archive is rejected
 * outright. A file that fails the injection scan is still quarantined (never
 * activated), with the scan result reported to the caller/UI.
 */
export async function importCacheIntoStore(
  storePath: string,
  sourcePath: string
): Promise<ImportCacheResult> {
  const storeDir = resolve(storePath);
  const quarantineDir = join(storeDir, "untrusted");
  await mkdir(quarantineDir, { recursive: true });
  const src = resolve(sourcePath);
  if (!src.endsWith(".claw-cache")) {
    throw new Error("Source must be a .claw-cache file");
  }

  // Full validation before the file touches the store at all.
  const content = await loadCacheFromPath(src);
  if (!content.scanReport.integrity) {
    // loadCacheFromPath throws on integrity failures, so this is unreachable.
    throw new Error("Integrity check unavailable");
  }

  const destName = await uniqueDestName(quarantineDir, basename(src));
  const dest = join(quarantineDir, destName);
  await copyFile(src, dest);
  const list = await listQuarantinedCaches(storeDir);
  const item = list.find((c) => c.file_name === destName);
  if (!item) {
    throw new Error("Imported file, but could not read manifest");
  }
  return {
    cache: item,
    quarantined: true,
    scan: {
      passedInjectionScan: content.passedInjectionScan,
      integrity: content.scanReport.integrity,
      signed: !!content.scanReport.signature?.verified,
      warnings: content.scanReport.warnings,
      injectionIssues: content.scanReport.injectionIssues.length,
    },
  };
}

export interface AcceptCacheResult {
  cache: CatalogCacheItem;
  fromFile: string;
  toFile: string;
}

/**
 * Explicit human acceptance: moves a quarantined cache into the active store.
 * Refuses when the injection scan fails (the cache stays quarantined). Clears
 * any stale TOFU key pin for the cache_id — acceptance is the resolution.
 */
export async function acceptQuarantinedCache(
  storePath: string,
  fileName: string
): Promise<AcceptCacheResult> {
  const storeDir = resolve(storePath);
  const src = resolveUnderStore(storePath, fileName, "untrusted");
  if (!src) throw new Error("Invalid file_name");

  const content = await loadCacheFromPath(src);
  if (!content.passedInjectionScan) {
    throw new Error(
      `Cache failed the injection scan (${content.scanReport.injectionIssues.length} hit(s)); not accepted. Delete it or inspect the file manually.`
    );
  }

  // Acceptance resolves any key-identity question in the human's favor.
  clearCacheKeyPin(join(storeDir, "untrusted"), content.manifest.cache_id);
  clearCacheKeyPin(storeDir, content.manifest.cache_id);

  const destName = await uniqueDestName(storeDir, basename(src));
  const dest = join(storeDir, destName);
  await rename(src, dest);
  const list = await listCachesFromDir(storeDir);
  const item = list.find((c) => c.file_name === destName);
  if (!item) throw new Error("Accepted, but could not re-read manifest");
  return { cache: item, fromFile: basename(src), toFile: destName };
}

/** Update manifest.name inside .claw-cache (active store or quarantine).*/
export async function renameCacheDisplayName(
  storePath: string,
  fileName: string,
  newName: string
): Promise<CatalogCacheItem> {
  const name = sanitizeDisplayText(newName, 200);
  if (!name) throw new Error("name is required");
  const full = resolveUnderStore(storePath, fileName) ?? resolveUnderStore(storePath, fileName, "untrusted");
  if (!full) throw new Error("Invalid file_name");
  const buf = await readFile(full);
  const zip = await JSZip.loadAsync(buf);
  const entry = zip.file("manifest.json");
  if (!entry) throw new Error("manifest.json missing");
  const manifest = JSON.parse(await entry.async("string")) as Record<string, unknown>;
  manifest.name = name;
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await writeFile(full, out);
  const quarantined = full.includes(join(resolve(storePath), "untrusted"));
  const list = quarantined ? await listQuarantinedCaches(storePath) : await listCachesFromDir(storePath);
  const item = list.find((c) => c.file_name === basename(full));
  if (!item) throw new Error("Renamed, but could not re-read manifest");
  return item;
}

/** Remove the cache file from the store or the quarantine directory.*/
export async function deleteCacheFile(storePath: string, fileName: string): Promise<void> {
  const full = resolveUnderStore(storePath, fileName) ?? resolveUnderStore(storePath, fileName, "untrusted");
  if (!full) throw new Error("Invalid file_name");
  await unlink(full);
}
