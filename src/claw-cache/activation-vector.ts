// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Chain of activation vectors (HSS ContextEncoder 64-dim) for .claw-cache.
 * vector.npy: float32 shape [N, 64] - one line per dialogue line.
 */

import { encodeHssContext, HSS_CONTEXT_EMBEDDING_DIM } from "./hss-context-encoder.js";
import { npyToRows, readNpyFloat32, rowsToNpy, writeNpyFloat32 } from "./npy.js";

export const ACTIVATION_VECTOR_DIM = HSS_CONTEXT_EMBEDDING_DIM;
export const MAX_ACTIVATION_VECTOR_TURNS = 20;

/** Local copy of unwrap - without import loop with session-export.*/
function unwrapExt(text: string): string {
  const trimmed = text.trim();
  const extMatch = trimmed.match(/<<<EXT>>>[\s\S]*?---\s*([\s\S]*?)<<<\/EXT>>>/i);
  if (extMatch?.[1]) return extMatch[1].trim();
  return trimmed.replace(/<<<EXT>>>|<<<\/EXT>>>/gi, "").trim();
}

export type ActivationVectorMatrix = {
  /** [N][DIM] */
  rows: number[][];
  /** Replica texts aligned with rows (for seeds in HSS chronicle).*/
  contexts: string[];
  dim: number;
  encoder: string;
};

export function buildActivationVectorFromDialogueJsonl(
  dialogueJsonl: string,
  maxTurns = MAX_ACTIVATION_VECTOR_TURNS
): ActivationVectorMatrix {
  const contexts: string[] = [];
  for (const line of dialogueJsonl.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t) as { role?: string; content?: string };
      if (row.role !== "user" && row.role !== "assistant") continue;
      const content = typeof row.content === "string" ? unwrapExt(row.content).trim() : "";
      if (!content) continue;
      contexts.push(content.slice(0, 2000));
      if (contexts.length >= maxTurns) break;
    } catch {
      // skip
    }
  }
  const rows = contexts.map((c) => encodeHssContext(c));
  return { rows, contexts, dim: ACTIVATION_VECTOR_DIM, encoder: "hss-context-64" };
}

export function buildActivationVectorFromMessages(
  messages: { role: string; content: string }[],
  maxTurns = MAX_ACTIVATION_VECTOR_TURNS
): ActivationVectorMatrix {
  const contexts: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const content = unwrapExt(msg.content).trim();
    if (!content) continue;
    contexts.push(content.slice(0, 2000));
    if (contexts.length >= maxTurns) break;
  }
  const rows = contexts.map((c) => encodeHssContext(c));
  return { rows, contexts, dim: ACTIVATION_VECTOR_DIM, encoder: "hss-context-64" };
}

export function activationVectorToNpyBuffer(matrix: ActivationVectorMatrix): Buffer {
  if (!matrix.rows.length) {
    return writeNpyFloat32(new Float32Array(0), [0, matrix.dim || ACTIVATION_VECTOR_DIM]);
  }
  const npy = rowsToNpy(matrix.rows);
  return writeNpyFloat32(npy.data, npy.shape);
}

export function activationVectorFromNpyBuffer(buf: Buffer): ActivationVectorMatrix | null {
  if (!buf?.length) return null;
  try {
    const npy = readNpyFloat32(buf);
    const rows = npyToRows(npy);
    if (!rows.length) {
      return { rows: [], contexts: [], dim: ACTIVATION_VECTOR_DIM, encoder: "hss-context-64" };
    }
    const dim = rows[0]!.length;
    if (dim !== ACTIVATION_VECTOR_DIM) {
      // allow other dim (old/external caches), but mark
      return {
        rows,
        contexts: rows.map((_, i) => `[activation:${i}]`),
        dim,
        encoder: "hss-context-64",
      };
    }
    return {
      rows,
      contexts: rows.map((_, i) => `[activation:${i}]`),
      dim,
      encoder: "hss-context-64",
    };
  } catch {
    return null;
  }
}

export function meanActivationVector(rows: number[][]): number[] {
  if (!rows.length) return new Array(ACTIVATION_VECTOR_DIM).fill(0);
  const dim = rows[0]!.length;
  const acc = new Array(dim).fill(0);
  for (const row of rows) {
    for (let i = 0; i < dim; i++) acc[i] += row[i] ?? 0;
  }
  for (let i = 0; i < dim; i++) acc[i] /= rows.length;
  return acc;
}
