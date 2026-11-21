// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Integrity and provenance for .claw-cache files (sharing scenario).
 *
 * security/digests.sha256 — per-entry sha256 of every content entry (anything
 * except the security/* files themselves). Detects any modification of a
 * single entry, including partial repackaging.
 *
 * security/signature.sig — Ed25519 signature over the digests file, with the
 * embedded public key. A signature does not make an unknown author trusted;
 * it makes the author *persistent*: the first key seen for a cache_id is
 * pinned (TOFU, .security/known-keys.json in the cache store). A cache that
 * later arrives under the same cache_id with a different key is rejected —
 * that pattern catches swapped/rebranded hostile caches.
 */

import { createHash, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type JSZip from "jszip";
import type { CacheSignatureInfo } from "./types.js";

export const DIGESTS_PATH = "security/digests.sha256";
export const SIGNATURE_PATH = "security/signature.sig";
/** Entries excluded from digest coverage (they carry the digests/signature). */
const UNCOVERED_PATHS = new Set([DIGESTS_PATH, SIGNATURE_PATH]);

const DEFAULT_KEY_PATH = resolve(process.cwd(), ".claw2", "keys", "cache-signing-key.pem");

export interface CacheSigningKey {
  privateKeyPem: string;
  publicKeyPem: string;
  keyId: string;
  keyPath: string | null;
}

export function keyIdFromPublicKeyPem(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

function keyIdFromPrivateKeyPem(privateKeyPem: string): string {
  const pub = createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString();
  return keyIdFromPublicKeyPem(pub);
}

/**
 * Loads the signing key from CLAW2_CACHE_SIGNING_KEY (raw PEM) or
 * .claw2/keys/cache-signing-key.pem; generates and persists one if missing.
 * Returns null when key material cannot be created (export stays unsigned).
 */
export function loadOrCreateSigningKey(env = process.env): CacheSigningKey | null {
  try {
    const raw = typeof env.CLAW2_CACHE_SIGNING_KEY === "string" ? env.CLAW2_CACHE_SIGNING_KEY.trim() : "";
    if (raw) {
      const privateKeyPem = raw.includes("PRIVATE KEY") ? raw : "";
      if (privateKeyPem) {
        return {
          privateKeyPem,
          publicKeyPem: createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString(),
          keyId: keyIdFromPrivateKeyPem(privateKeyPem),
          keyPath: null,
        };
      }
    }
    const keyPath = typeof env.CLAW2_CACHE_SIGNING_KEY_PATH === "string" && env.CLAW2_CACHE_SIGNING_KEY_PATH.trim()
      ? resolve(env.CLAW2_CACHE_SIGNING_KEY_PATH.trim())
      : DEFAULT_KEY_PATH;
    if (existsSync(keyPath)) {
      const privateKeyPem = readFileSync(keyPath, "utf8");
      return {
        privateKeyPem,
        publicKeyPem: createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString(),
        keyId: keyIdFromPrivateKeyPem(privateKeyPem),
        keyPath,
      };
    }
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
    return {
      privateKeyPem,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      keyId: keyIdFromPrivateKeyPem(privateKeyPem),
      keyPath,
    };
  } catch {
    return null;
  }
}

/** Canonical digests text: "<sha256hex>  <path>" lines, sorted by path. */
export function buildDigestsText(entries: { path: string; bytes: Buffer }[]): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sorted.map((e) => `${createHash("sha256").update(e.bytes).digest("hex")}  ${e.path}`).join("\n") + "\n";
}

/** Computes digests over every covered entry currently present in the zip. */
export async function computeDigestsForZip(zip: JSZip): Promise<{ text: string; paths: string[] }> {
  const entries: { path: string; bytes: Buffer }[] = [];
  for (const path of Object.keys(zip.files)) {
    const file = zip.files[path];
    if (!file || file.dir || UNCOVERED_PATHS.has(path)) continue;
    const bytes = await zip.file(path)!.async("nodebuffer");
    entries.push({ path, bytes });
  }
  return { text: buildDigestsText(entries), paths: entries.map((e) => e.path) };
}

export interface SignCacheResult {
  signed: boolean;
  keyId?: string;
  error?: string;
}

/** Adds security/digests.sha256 and security/signature.sig to the zip (in place). */
export async function signCacheZip(zip: JSZip, env = process.env): Promise<SignCacheResult> {
  const key = loadOrCreateSigningKey(env);
  if (!key) return { signed: false, error: "signing key unavailable" };
  const { text } = await computeDigestsForZip(zip);
  zip.file(DIGESTS_PATH, text);
  const signature = cryptoSign(null, Buffer.from(text, "utf8"), key.privateKeyPem).toString("base64");
  const payload = {
    algorithm: "ed25519",
    key_id: key.keyId,
    public_key_pem: key.publicKeyPem,
    signed_at: new Date().toISOString(),
    digests_sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    signature,
  };
  zip.file(SIGNATURE_PATH, JSON.stringify(payload, null, 2) + "\n");
  return { signed: true, keyId: key.keyId };
}

export interface VerifyCacheResult {
  status: "verified" | "none" | "invalid";
  info: CacheSignatureInfo | null;
  error?: string;
}

/**
 * Verifies digests (when present) and the signature (when present).
 * - no digests and no signature → "none" (legacy cache, integrity unchecked)
 * - digests mismatch, malformed or unverifiable signature → "invalid"
 */
export async function verifyCacheSignature(zip: JSZip): Promise<VerifyCacheResult> {
  const digestsEntry = zip.file(DIGESTS_PATH);
  const sigEntry = zip.file(SIGNATURE_PATH);
  if (!digestsEntry && !sigEntry) {
    return { status: "none", info: null };
  }
  if (!digestsEntry && sigEntry) {
    return { status: "invalid", info: null, error: "signature without digests file" };
  }

  const digestsText = await digestsEntry!.async("string");
  const expected = new Map<string, string>();
  for (const line of digestsText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^([0-9a-f]{64})\s{2}(.+)$/);
    if (!m) return { status: "invalid", info: null, error: "malformed digests line" };
    expected.set(m[2]!, m[1]!);
  }
  for (const [path, hex] of expected) {
    const file = zip.file(path);
    if (!file) return { status: "invalid", info: null, error: `digests cover missing entry: ${path}` };
    const bytes = await file.async("nodebuffer");
    const actual = createHash("sha256").update(bytes).digest("hex");
    const ok =
      actual.length === hex.length &&
      timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(hex, "hex"));
    if (!ok) return { status: "invalid", info: null, error: `digest mismatch for ${path}` };
  }

  if (!sigEntry) {
    return { status: "none", info: null };
  }
  let payload: {
    algorithm?: string;
    key_id?: string;
    public_key_pem?: string;
    signed_at?: string;
    signature?: string;
  };
  try {
    payload = JSON.parse(await sigEntry.async("string"));
  } catch {
    return { status: "invalid", info: null, error: "malformed signature.sig" };
  }
  if (payload.algorithm !== "ed25519" || !payload.key_id || !payload.public_key_pem || !payload.signature) {
    return { status: "invalid", info: null, error: "signature payload incomplete" };
  }
  let keyId: string;
  try {
    keyId = keyIdFromPublicKeyPem(payload.public_key_pem);
  } catch {
    return { status: "invalid", info: null, error: "invalid public key" };
  }
  if (keyId !== payload.key_id) {
    return { status: "invalid", info: null, error: "key_id does not match embedded key" };
  }
  let verified = false;
  try {
    verified = cryptoVerify(
      null,
      Buffer.from(digestsText, "utf8"),
      createPublicKey(payload.public_key_pem!),
      Buffer.from(payload.signature, "base64")
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    return { status: "invalid", info: null, error: "signature does not match digests" };
  }
  return {
    status: "verified",
    info: {
      algorithm: "ed25519",
      keyId: payload.key_id!,
      verified: true,
      signedAt: typeof payload.signed_at === "string" ? payload.signed_at : undefined,
    },
  };
}

// --- TOFU key pinning -------------------------------------------------------

interface KnownKeyEntry {
  keyId: string;
  first_seen: string;
}

function pinFilePath(storeDir: string): string {
  return join(resolve(storeDir), ".security", "known-keys.json");
}

function readPins(storeDir: string): Record<string, KnownKeyEntry> {
  try {
    const raw = readFileSync(pinFilePath(storeDir), "utf8");
    const parsed = JSON.parse(raw) as Record<string, KnownKeyEntry>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writePins(storeDir: string, pins: Record<string, KnownKeyEntry>): void {
  try {
    const path = pinFilePath(storeDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(pins, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Pinning is best-effort; never break cache loading on write failure.
  }
}

export class CacheKeyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheKeyConflictError";
  }
}

/**
 * TOFU check: a cache_id seen with a different signing key is rejected. The
 * caller decides which directory is authoritative for the pin store (normally
 * the directory the cache lives in).
 */
export function verifyAndPinCacheKey(storeDir: string, cacheId: string, info: CacheSignatureInfo | null): void {
  if (!info?.verified || !cacheId) return;
  const pins = readPins(storeDir);
  const known = pins[cacheId];
  if (known && known.keyId !== info.keyId) {
    throw new CacheKeyConflictError(
      `claw-cache identity conflict: cache_id "${cacheId}" was previously signed with key ${known.keyId}, this file is signed with ${info.keyId}. If this replacement is expected, delete ${pinFilePath(storeDir)}`
    );
  }
  if (!known) {
    pins[cacheId] = { keyId: info.keyId, first_seen: new Date().toISOString() };
    writePins(storeDir, pins);
  }
}

/** Drops the TOFU pin for a cache_id (explicit human re-acceptance). */
export function clearCacheKeyPin(storeDir: string, cacheId: string): boolean {
  const pins = readPins(storeDir);
  if (pins[cacheId]) {
    delete pins[cacheId];
    writePins(storeDir, pins);
    return true;
  }
  return false;
}
