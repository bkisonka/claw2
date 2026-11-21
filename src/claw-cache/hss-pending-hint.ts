// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * HSS hint from the previous turn (HssMiddleware result) — injected into the next request's system prompt.
 */

export type PendingHssStatus = "STABLE" | "FRAGMENTED" | "CRITICAL";

export interface PendingHssResponseHint {
  status: PendingHssStatus;
  recommendation?: string;
  entropyDelta: number;
  coherence: number;
  recordedAt: string;
}

const pendingBySession = new Map<string, PendingHssResponseHint>();

function sessionKey(sessionId: string, cacheId: string): string {
  return `${sessionId}:${cacheId}`;
}

export function setPendingHssResponseHint(
  sessionId: string,
  cacheId: string,
  hint: Omit<PendingHssResponseHint, "recordedAt">
): void {
  if (hint.status !== "FRAGMENTED" && hint.status !== "CRITICAL") return;
  if (!hint.recommendation?.trim()) return;
  pendingBySession.set(sessionKey(sessionId, cacheId), {
    ...hint,
    recordedAt: new Date().toISOString(),
  });
}

/** Takes and removes the hint (once on the next turn).*/
export function consumePendingHssResponseHint(
  sessionId: string,
  cacheId: string
): PendingHssResponseHint | null {
  const key = sessionKey(sessionId, cacheId);
  const hint = pendingBySession.get(key) ?? null;
  if (hint) pendingBySession.delete(key);
  return hint;
}

export function releasePendingHssHints(sessionId: string): number {
  const prefix = `${sessionId}:`;
  let deleted = 0;
  for (const key of pendingBySession.keys()) {
    if (key.startsWith(prefix) && pendingBySession.delete(key)) deleted += 1;
  }
  return deleted;
}
