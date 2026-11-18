/**
 * Loading .claw-cache from a (ZIP) file. Reading manifest.json and activation/triggers.json.
 * File reading is asynchronous with a timeout, so as not to block the request on a slow/network FS.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import JSZip from "jszip";
import type { ClawCacheManifest, ClawCacheTriggers, ClawCacheContent } from "./types.js";
import { scanTriggers } from "./CacheInjectionScanner.js";
import { activationVectorFromNpyBuffer } from "./activation-vector.js";
import { parseDialogueJsonl } from "./WarmupBuilder.js";

const REQUIRED_VERSION = "1.0";

/** .claw-cache file read timeout (ms). If exceeded, an exception occurs; the orchestrator does not freeze.*/
const LOAD_FILE_TIMEOUT_MS = 15_000;

async function readZipEntryAsStringAsync(zip: JSZip, path: string): Promise<string | null> {
  const entry = zip.file(path);
  if (!entry) return null;
  return entry.async("string");
}

/**
 * Loads .claw-cache from the file path. Checks format_version, reads manifest and triggers.
 * Runs triggers through CacheInjectionScanner; when triggered passedInjectionScan = false.
 */
export async function loadCacheFromPath(filePath: string): Promise<ClawCacheContent> {
  const absolute = resolve(filePath);
  let buf: Buffer;
  try {
    buf = await readFile(absolute, {
      signal: AbortSignal.timeout(LOAD_FILE_TIMEOUT_MS),
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { name?: string };
    if (e?.code === "ENOENT") {
      throw new Error(`Claw-cache file not found: ${absolute}`);
    }
    if (e?.name === "AbortError") {
      throw new Error(`Claw-cache read timeout: ${absolute}`);
    }
    throw err;
  }
  const zip = await JSZip.loadAsync(buf);
  const manifestStr = await readZipEntryAsStringAsync(zip, "manifest.json");
  if (!manifestStr) throw new Error("Claw-cache: missing manifest.json");
  let manifest: ClawCacheManifest;
  try {
    manifest = JSON.parse(manifestStr) as ClawCacheManifest;
  } catch {
    throw new Error("Claw-cache: invalid manifest.json");
  }
  const version = manifest.format_version ?? "";
  if (version !== REQUIRED_VERSION) {
    throw new Error(`Claw-cache: unsupported format_version ${version}, expected ${REQUIRED_VERSION}`);
  }
  if (!manifest.cache_id) throw new Error("Claw-cache: manifest missing cache_id");

  let triggers: ClawCacheTriggers | null = null;
  const triggersStr = await readZipEntryAsStringAsync(zip, "activation/triggers.json");
  if (triggersStr) {
    try {
      triggers = JSON.parse(triggersStr) as ClawCacheTriggers;
    } catch {
      // optional
    }
  }

  let dialogueRaw: string | null = null;
  const dialogueEntry = zip.file("activation/dialogue.jsonl");
  if (dialogueEntry) {
    dialogueRaw = await dialogueEntry.async("string");
  }

  let activationVector: ClawCacheContent["activationVector"] = null;
  const vectorEntry = zip.file("activation/vector.npy");
  if (vectorEntry) {
    const raw = await vectorEntry.async("nodebuffer");
    const parsed = activationVectorFromNpyBuffer(Buffer.from(raw));
    if (parsed && parsed.rows.length > 0) {
      const dialogueMsgs = parseDialogueJsonl(dialogueRaw);
      const contexts = parsed.rows.map((_, i) => {
        const fromDialogue = dialogueMsgs[i]?.content?.trim();
        return fromDialogue || parsed.contexts[i] || `[activation:${i}]`;
      });
      activationVector = { ...parsed, contexts };
    } else if (parsed) {
      activationVector = parsed;
    }
  }

  const scanResult = scanTriggers(triggers);
  return {
    manifest,
    triggers,
    dialogueRaw,
    activationVector,
    passedInjectionScan: scanResult.passed,
    source: absolute,
  };
}
