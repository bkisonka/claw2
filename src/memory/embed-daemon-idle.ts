// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/** Idle policy for the shared ONNX embed daemon. */

export const DEFAULT_EMBED_IDLE_MS = 60 * 60 * 1000;

export function resolveEmbedIdleMs(envValue?: string | null): number {
  const raw = envValue?.trim();
  if (!raw) return DEFAULT_EMBED_IDLE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1_000) return DEFAULT_EMBED_IDLE_MS;
  return Math.floor(n);
}

export function shouldIdleExit(lastActivityAt: number, now: number, idleMs: number): boolean {
  if (!(idleMs > 0) || !(lastActivityAt > 0)) return false;
  return now - lastActivityAt >= idleMs;
}

/** How often to poll idle state — short enough for tests, light for production. */
export function resolveIdleCheckIntervalMs(idleMs: number): number {
  return Math.min(60_000, Math.max(5_000, Math.floor(idleMs / 12)));
}
