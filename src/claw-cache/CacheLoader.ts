/**
 * Loading .claw-cache from a (ZIP) file.
 *
 * Security posture for shared/foreign caches (fail closed):
 *   - archive and per-entry size caps before any decompressed read;
 *   - entry allowlist (unknown entries produce warnings);
 *   - per-entry digests verified when security/digests.sha256 is present;
 *   - Ed25519 signature verified when present; invalid/never "pass-through";
 *   - TOFU key pinning per cache_id (conflicting replacement key rejects);
 *   - injection scan covers triggers AND every dialogue line (single + adjacent
 *     windows). A failing scan marks passedInjectionScan=false — the warmup is
 *     skipped and the vector.npy seed (which previously bypassed the dialogue
 *     scan) is never set.
 */

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import JSZip from "jszip";
import type { ClawCacheManifest, ClawCacheTriggers, ClawCacheContent, CacheScanReport, CacheSignatureInfo } from "./types.js";
import { scanTriggers, scanDialogueMessages, sanitizeDisplayText } from "./CacheInjectionScanner.js";
import {
  verifyCacheSignature,
  verifyAndPinCacheKey,
  type VerifyCacheResult,
} from "./cache-signature.js";
import { activationVectorFromNpyBuffer } from "./activation-vector.js";
import { parseDialogueJsonl } from "./WarmupBuilder.js";

const REQUIRED_VERSION = "1.0";

/** .claw-cache file read timeout (ms). If exceeded, an exception occurs; the orchestrator does not freeze.*/
const LOAD_FILE_TIMEOUT_MS = 15_000;

/** Max archive size on disk (compressed). */
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;

/** Per-entry uncompressed caps, checked before reading via JSZip metadata. */
const ENTRY_MAX_BYTES: Record<string, number> = {
  "manifest.json": 64 * 1024,
  "activation/triggers.json": 256 * 1024,
  "activation/dialogue.jsonl": 2 * 1024 * 1024,
  "activation/vector.npy": 1 * 1024 * 1024,
  "activation/vector.meta.json": 8 * 1024,
  "security/digests.sha256": 64 * 1024,
  "security/signature.sig": 16 * 1024,
};
const DEFAULT_ENTRY_MAX_BYTES = 512 * 1024;

const KNOWN_ENTRY_PREFIXES = ["manifest.json", "activation/", "generation/", "usage/", "security/"];

async function readZipEntryAsStringAsync(zip: JSZip, path: string): Promise<string | null> {
  const entry = zip.file(path);
  if (!entry) return null;
  const capped = ENTRY_MAX_BYTES[path] ?? DEFAULT_ENTRY_MAX_BYTES;
  const meta = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
  if (typeof meta?.uncompressedSize === "number" && meta.uncompressedSize > capped) {
    throw new Error(`Claw-cache: entry ${path} too large (${meta.uncompressedSize} bytes, cap ${capped})`);
  }
  const str = await entry.async("string");
  if (Buffer.byteLength(str, "utf8") > capped) {
    throw new Error(`Claw-cache: entry ${path} too large (cap ${capped} bytes)`);
  }
  return str;
}

function collectUnknownEntryWarnings(zip: JSZip, warnings: string[]): void {
  for (const path of Object.keys(zip.files)) {
    const file = zip.files[path];
    if (!file || file.dir) continue;
    if (!KNOWN_ENTRY_PREFIXES.some((p) => path.startsWith(p))) {
      warnings.push(`unknown ZIP entry: ${path}`);
    }
  }
}

/**
 * Loads .claw-cache from the file path. Checks format_version, manifest,
 * digests/signature, runs triggers and the full dialogue through the injection
 * scanner. Throws on integrity/signature failures (fail closed).
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
  if (buf.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`Claw-cache: archive too large (${buf.length} bytes, cap ${MAX_ARCHIVE_BYTES})`);
  }
  const zip = await JSZip.loadAsync(buf).catch((err) => {
    throw new Error(`Claw-cache: invalid ZIP archive (${err instanceof Error ? err.message : String(err)})`);
  });

  const warnings: string[] = [];
  collectUnknownEntryWarnings(zip, warnings);

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
  if (!manifest.cache_id || typeof manifest.cache_id !== "string") {
    throw new Error("Claw-cache: manifest missing cache_id");
  }
  // Display fields are never executed, but they reach the catalog UI: strip
  // control characters and cap length, record oversized raw values.
  for (const field of ["name", "description", "author", "domain", "language"] as const) {
    const raw = manifest[field];
    if (typeof raw === "string" && raw.length > 300) {
      warnings.push(`manifest.${field} exceeds 300 chars, truncated`);
    }
    if (typeof raw === "string") {
      (manifest as unknown as Record<string, unknown>)[field] = sanitizeDisplayText(raw);
    }
  }

  // --- integrity + provenance (fail closed on invalid) ---
  let verify: VerifyCacheResult;
  try {
    verify = await verifyCacheSignature(zip);
  } catch (err) {
    throw new Error(`Claw-cache: integrity check failed (${err instanceof Error ? err.message : String(err)})`);
  }
  if (verify.status === "invalid") {
    throw new Error(`Claw-cache: signature/digest verification failed (${verify.error ?? "unknown"})`);
  }
  if (verify.status === "none") {
    warnings.push("no digests/signature: integrity not verified (legacy cache)");
  }
  const cacheDir = dirname(absolute);
  try {
    verifyAndPinCacheKey(cacheDir, manifest.cache_id, verify.info);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }

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
    dialogueRaw = await readZipEntryAsStringAsync(zip, "activation/dialogue.jsonl");
  }

  // --- injection scan: triggers + full dialogue (single messages + windows) ---
  const injectionIssues: CacheScanReport["injectionIssues"] = [];
  const triggerScan = scanTriggers(triggers);
  for (const m of triggerScan.matches) {
    injectionIssues.push({ line: -1, role: null, windowSize: 1, category: m.category, sample: m.sample });
  }
  const dialogueMessages = parseDialogueJsonl(dialogueRaw);
  const dialogueScan = scanDialogueMessages(dialogueMessages);
  for (const issue of dialogueScan.issues) {
    for (const m of issue.matches) {
      injectionIssues.push({
        line: issue.line,
        role: issue.role,
        windowSize: issue.windowSize,
        category: m.category,
        sample: m.sample,
      });
    }
  }
  const passedInjectionScan = triggerScan.passed && dialogueScan.passed;
  if (!passedInjectionScan) {
    warnings.push(`injection scan failed: ${injectionIssues.length} hit(s); warmup and vector seed are disabled`);
  }

  let activationVector: ClawCacheContent["activationVector"] = null;
  const vectorEntry = zip.file("activation/vector.npy");
  if (vectorEntry) {
    const capped = ENTRY_MAX_BYTES["activation/vector.npy"] ?? DEFAULT_ENTRY_MAX_BYTES;
    const meta = (vectorEntry as unknown as { _data?: { uncompressedSize?: number } })._data;
    if (typeof meta?.uncompressedSize === "number" && meta.uncompressedSize > capped) {
      throw new Error(`Claw-cache: activation/vector.npy too large (${meta.uncompressedSize} bytes, cap ${capped})`);
    }
    const raw = await vectorEntry.async("nodebuffer");
    const parsed = activationVectorFromNpyBuffer(Buffer.from(raw));
    if (parsed && parsed.rows.length > 0) {
      // Contexts come from the same dialogue that just passed (or failed) the
      // scan — no unscanned path into the HSS chronicle anymore.
      const contexts = parsed.rows.map((_, i) => {
        const fromDialogue = dialogueMessages[i]?.content?.trim();
        return (fromDialogue && passedInjectionScan ? fromDialogue : parsed.contexts[i]) || `[activation:${i}]`;
      });
      activationVector = { ...parsed, contexts };
    } else if (parsed) {
      activationVector = parsed;
    }
  }

  const signatureInfo: CacheSignatureInfo | null = verify.info;
  const scanReport: CacheScanReport = {
    integrity: verify.status === "verified" ? "verified" : "none",
    signature: signatureInfo,
    warnings,
    injectionIssues,
    scanChecked: dialogueScan.checked,
  };

  return {
    manifest,
    triggers,
    dialogueRaw,
    activationVector,
    passedInjectionScan,
    source: absolute,
    scanReport,
  };
}
