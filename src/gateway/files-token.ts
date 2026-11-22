// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/** Short-lived grants for a single file, issued to an authenticated caller. */
import { createHmac, timingSafeEqual } from "node:crypto";

export const FILES_TOKEN_TTL_MS = 10 * 60_000;
const TOKEN_PREFIX = "claw2-files:";

export function signFilesToken(secret: string, userId: string, exp: number, path: string): string {
  const sig = createHmac("sha256", secret).update(JSON.stringify([TOKEN_PREFIX, userId, exp, path])).digest("hex");
  return `${userId}.${exp}.${sig}`;
}

export function verifyFilesToken(
  secret: string,
  k: string,
  path: string,
  now: number = Date.now()
): { userId: string } | null {
  if (!secret) return null;
  const parts = k.split(".");
  if (parts.length !== 3) return null;
  const [userId, expRaw, sig] = parts as [string, string, string];
  if (!userId.trim()) return null;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= now || exp > now + FILES_TOKEN_TTL_MS + 60_000) return null;
  const expected = signFilesToken(secret, userId, exp, path).split(".")[2] ?? "";
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

/** Decode exactly the path that the file handler will resolve and sign. */
export function filesReadPath(pathname: string): string | null {
  if (!pathname.startsWith("/files/")) return null;
  try {
    const path = decodeURIComponent(pathname.slice("/files/".length));
    const [root, ...parts] = path.split("/");
    if ((root !== "uploads" && root !== "output") || parts.length === 0) return null;
    if (parts.some((part) => !part || part === "." || part === ".." || /[\\\x00-\x1f\x7f]/.test(part))) return null;
    return path;
  } catch {
    return null;
  }
}
