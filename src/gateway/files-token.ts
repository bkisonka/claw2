// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Short-lived signed token (query param "k") for /files.
 *
 * Browser media loads (<img>/<audio>/<video>/<a>) carry no auth headers, so
 * with gateway auth enabled they could not fetch files at all — and per-user
 * gating was impossible. GET /api/files-token issues an HMAC bound to the
 * user + expiry to already-authenticated clients; GET /files verifies it.
 * Auth-off single-owner deployments have no secret to sign with and keep
 * header-less /files as before.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const FILES_TOKEN_TTL_MS = 10 * 60_000;
const TOKEN_PREFIX = "claw2-files:";

export function signFilesToken(secret: string, userId: string, exp: number): string {
  const sig = createHmac("sha256", secret).update(`${TOKEN_PREFIX}${userId}:${exp}`).digest("hex");
  return `${userId}.${exp}.${sig}`;
}

export function verifyFilesToken(
  secret: string,
  k: string,
  now: number = Date.now()
): { userId: string } | null {
  if (!secret) return null;
  const parts = k.split(".");
  if (parts.length !== 3) return null;
  const [userId, expRaw, sig] = parts as [string, string, string];
  if (!userId.trim()) return null;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < now || exp > now + FILES_TOKEN_TTL_MS + 60_000) return null;
  const expected = signFilesToken(secret, userId, exp).split(".")[2] ?? "";
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || a.length === 0) return null;
  try {
    if (!timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return { userId };
}
