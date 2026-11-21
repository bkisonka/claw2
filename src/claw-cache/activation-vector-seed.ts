// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Pending seed of the chain of activation vectors → mixed into the HSS chronicle when creating a node.
 */

import type { ActivationVectorMatrix } from "./activation-vector.js";

const pending = new Map<string, ActivationVectorMatrix>();

function key(sessionId: string, cacheId: string): string {
  return `${sessionId}:${cacheId}`;
}

export function setActivationVectorSeed(
  sessionId: string,
  cacheId: string,
  matrix: ActivationVectorMatrix
): void {
  if (!matrix.rows.length) return;
  pending.set(key(sessionId, cacheId), matrix);
}

/** Takes the seed once (when creating an HSS node).*/
export function consumeActivationVectorSeed(
  sessionId: string,
  cacheId: string
): ActivationVectorMatrix | null {
  const k = key(sessionId, cacheId);
  const v = pending.get(k) ?? null;
  if (v) pending.delete(k);
  return v;
}

export function peekActivationVectorSeed(
  sessionId: string,
  cacheId: string
): ActivationVectorMatrix | null {
  return pending.get(key(sessionId, cacheId)) ?? null;
}

export function releaseActivationVectorSeeds(sessionId: string): number {
  const prefix = `${sessionId}:`;
  let deleted = 0;
  for (const pendingKey of pending.keys()) {
    if (pendingKey.startsWith(prefix) && pending.delete(pendingKey)) deleted += 1;
  }
  return deleted;
}
