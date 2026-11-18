/**
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * Wrapper over ContextEncoder from hss.cjs (64-dim hash vector for a topological node).
 */

import { loadHssModule } from "./hss-path.js";

const HSS_EMBEDDING_DIM = 64;

let encoder: { encode: (text: string) => number[] } | null = null;

function getEncoder(): { encode: (text: string) => number[] } | null {
  if (encoder) return encoder;
  const loaded = loadHssModule<{
    ContextEncoder?: new (dim?: number) => { encode: (text: string) => number[] };
  }>();
  if (!loaded?.mod?.ContextEncoder) return null;
  encoder = new loaded.mod.ContextEncoder(HSS_EMBEDDING_DIM);
  return encoder;
}

export function encodeHssContext(text: string): number[] {
  const enc = getEncoder();
  if (!enc) return new Array(HSS_EMBEDDING_DIM).fill(0);
  const vec = enc.encode(text ?? "");
  return Array.isArray(vec) && vec.length === HSS_EMBEDDING_DIM ? vec : new Array(HSS_EMBEDDING_DIM).fill(0);
}

export function serializeHssEmbedding(vec: number[]): string {
  const trimmed = vec.slice(0, HSS_EMBEDDING_DIM);
  while (trimmed.length < HSS_EMBEDDING_DIM) trimmed.push(0);
  return JSON.stringify(trimmed);
}

export function deserializeHssEmbedding(raw: string | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((x) => Number(x) || 0).slice(0, HSS_EMBEDDING_DIM);
  } catch {
    return [];
  }
}

export const HSS_CONTEXT_EMBEDDING_DIM = HSS_EMBEDDING_DIM;
