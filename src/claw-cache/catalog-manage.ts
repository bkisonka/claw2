/**
 * Managing activation cache directory files (import / rename / delete).
 */

import { access, copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import JSZip from "jszip";
import { listCachesFromDir, type CatalogCacheItem } from "./list-catalog.js";

export function safeCacheFileName(name: string): string | null {
  const base = basename(String(name ?? "").trim());
  if (!base || base.includes("..") || !base.endsWith(".claw-cache")) return null;
  if (base !== String(name ?? "").trim().replace(/^.*[/\\]/, "")) return null;
  return base;
}

function resolveUnderStore(storePath: string, fileName: string): string | null {
  const safe = safeCacheFileName(fileName);
  if (!safe) return null;
  const dir = resolve(storePath);
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

/** Copy .claw-cache to the store directory.*/
export async function importCacheIntoStore(
  storePath: string,
  sourcePath: string
): Promise<CatalogCacheItem> {
  const dir = resolve(storePath);
  await mkdir(dir, { recursive: true });
  const src = resolve(sourcePath);
  if (!src.endsWith(".claw-cache")) {
    throw new Error("Source must be a .claw-cache file");
  }
  const destName = await uniqueDestName(dir, basename(src));
  const dest = join(dir, destName);
  await copyFile(src, dest);
  const list = await listCachesFromDir(dir);
  const item = list.find((c) => c.file_name === destName);
  if (!item) {
    throw new Error("Imported file, but could not read manifest");
  }
  return item;
}

/** Update manifest.name inside .claw-cache.*/
export async function renameCacheDisplayName(
  storePath: string,
  fileName: string,
  newName: string
): Promise<CatalogCacheItem> {
  const name = String(newName ?? "").trim();
  if (!name) throw new Error("name is required");
  const full = resolveUnderStore(storePath, fileName);
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
  const list = await listCachesFromDir(storePath);
  const item = list.find((c) => c.file_name === basename(full));
  if (!item) throw new Error("Renamed, but could not re-read manifest");
  return item;
}

/** Remove the cache file from the directory.*/
export async function deleteCacheFile(storePath: string, fileName: string): Promise<void> {
  const full = resolveUnderStore(storePath, fileName);
  if (!full) throw new Error("Invalid file_name");
  await unlink(full);
}
