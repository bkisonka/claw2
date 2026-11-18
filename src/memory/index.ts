/**
 * Vector memory: write / recall. Backends: in-memory, chroma, sqlite-vec.
 */
import OpenAI from "openai";
import type { Claw2Config } from "../config/types.js";
import { auditLog } from "../audit/log.js";
import { getEmbedding } from "./embedding.js";
import { sanitizeForMemory, type MemorySource } from "./sanitize.js";
import { InMemoryStore, type IMemoryStore, type MemoryChunk } from "./store.js";
import { ChromaStore } from "./chroma-store.js";
import { SqliteVecStore } from "./sqlite-vec-store.js";
import { closeMemorySqlite } from "./sqlite-db.js";

export type { MemoryChunk, MemorySource };

export interface MemoryWriteResult {
  ok: boolean;
  id?: string;
  reason?: string;
}

export interface MemoryRecallResult {
  chunks: { text: string; source: MemorySource }[];
}

export interface MemoryRecallScoredResult {
  chunks: { text: string; source: MemorySource; score: number }[];
}

let defaultStore: IMemoryStore | null = null;
let defaultStoreBackend: string | null = null;

function resolveBackend(config: Claw2Config): string {
  return config.memory?.backend ?? "memory";
}

function getStore(config: Claw2Config): IMemoryStore {
  const backend = resolveBackend(config);
  if (defaultStore && defaultStoreBackend !== backend) {
    resetMemoryStore();
  }
  if (!defaultStore) {
    if (backend === "sqlite") {
      defaultStore = new SqliteVecStore(config);
    } else if (backend === "chroma" && config.memory?.chroma?.url?.trim()) {
      defaultStore = new ChromaStore(config);
    } else {
      defaultStore = new InMemoryStore({
        maxChunks: config.memory?.maxChunks ?? 500,
        maxRecallChunks: config.memory?.maxRecallChunks ?? 5,
      });
    }
    defaultStoreBackend = backend;
  }
  return defaultStore;
}

/** Reset singleton (after config save / backend change). */
export function resetMemoryStore(): void {
  defaultStore = null;
  defaultStoreBackend = null;
  closeMemorySqlite();
}

/**
 * Write a fragment to memory. Sanitization is mandatory; on failure ok=false.
 * userId — ID of the recognized user (vision); if present, the memory is attached to it.
 */
export async function memoryWrite(
  client: OpenAI,
  config: Claw2Config,
  text: string,
  source: MemorySource,
  userId?: string,
  importance?: number
): Promise<MemoryWriteResult> {
  if (!config.memory?.enabled) return { ok: false, reason: "memory_disabled" };

  const sanitized = sanitizeForMemory(text);
  if (!sanitized.allowed || !sanitized.sanitized) {
    auditLog(config, { type: "memory_denied", details: { reason: sanitized.reason ?? "sanitize_failed" } });
    return { ok: false, reason: sanitized.reason ?? "sanitize_failed" };
  }

  const imp =
    typeof importance === "number" && Number.isFinite(importance)
      ? Math.max(0, Math.min(1, importance))
      : 0.5;

  try {
    const embedding = await getEmbedding(client, config, sanitized.sanitized);
    const store = getStore(config);
    const id = await store.add({
      text: sanitized.sanitized,
      embedding,
      source,
      importance: imp,
      ...(userId ? { userId } : {}),
    });
    auditLog(config, { type: "memory_write", details: { importance: imp } });
    return { ok: true, id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[memory] memoryWrite failed:", msg);
    return { ok: false, reason: msg };
  }
}

export interface MemoryRecallOptions {
  userId?: string;
  isSuperuser?: boolean;
}

/**
 * Search by meaning: request → embedding → top-N chunks.
 * If you specify a userId and not a superuser, only records associated with that user are returned.
 */
export async function memoryRecall(
  client: OpenAI,
  config: Claw2Config,
  query: string,
  limit?: number,
  options?: MemoryRecallOptions
): Promise<MemoryRecallResult> {
  const scored = await memoryRecallScored(client, config, query, limit, options);
  return {
    chunks: scored.chunks.map((c) => ({ text: c.text, source: c.source })),
  };
}

/** Like memoryRecall but keeps store ranking scores for Insight Linker. */
export async function memoryRecallScored(
  client: OpenAI,
  config: Claw2Config,
  query: string,
  limit?: number,
  options?: MemoryRecallOptions
): Promise<MemoryRecallScoredResult> {
  if (!config.memory?.enabled) return { chunks: [] };

  const queryEmbedding = await getEmbedding(client, config, query);
  const store = getStore(config);
  const n = limit ?? config.memory?.maxRecallChunks ?? 5;
  if (store.recallScored) {
    const scored = await store.recallScored(queryEmbedding, n, options);
    return {
      chunks: scored.map((x) => ({ text: x.chunk.text, source: x.chunk.source, score: x.score })),
    };
  }
  const chunks = await store.recall(queryEmbedding, n, options);
  return {
    chunks: chunks.map((c, i) => ({
      text: c.text,
      source: c.source,
      score: Math.max(0, 1 - i * 0.08),
    })),
  };
}
