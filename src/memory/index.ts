// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

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
  chunks: {
    text: string;
    source: MemorySource;
    untrustedOrigin?: boolean;
    /** Record id + date: the model needs them to chain updates (replaces) and see versions. */
    id?: string;
    createdAt?: number;
    verifiedAt?: number;
  }[];
}

export interface MemoryRecallScoredResult {
  chunks: {
    text: string;
    source: MemorySource;
    score: number;
    untrustedOrigin?: boolean;
    id?: string;
    createdAt?: number;
    verifiedAt?: number;
  }[];
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
/**
 * Test-injection hooks (underscore-prefixed, exported for tests only):
 * the fallback mapping branch of memoryRecallScored is only reachable with
 * a store that lacks recallScored — the production stores all have it, so
 * the seam test swaps the active default for a recall-only view.
 */
export function __setMemoryStoreForTest(store: IMemoryStore | null): void {
  if (store === null) {
    resetMemoryStore();
    return;
  }
  defaultStore = store;
  defaultStoreBackend = "memory";
}

export function __getMemoryStoreForTest(): IMemoryStore | null {
  return defaultStore;
}

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
  importance?: number,
  originUntrusted?: boolean,
  lifecycle?: { replaces?: string; isSuperuser?: boolean }
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
    const id = await store.add(
      {
        text: sanitized.sanitized,
        embedding,
        source,
        importance: imp,
        ...(originUntrusted ? { untrustedOrigin: true } : {}),
        ...(userId ? { userId } : {}),
      },
      lifecycle?.replaces
        ? { replaces: lifecycle.replaces, isSuperuser: lifecycle.isSuperuser === true }
        : undefined
    );
    auditLog(config, {
      type: "memory_write",
      details: {
        importance: imp,
        untrustedOrigin: originUntrusted === true,
        ...(lifecycle?.replaces ? { replacedId: lifecycle.replaces } : {}),
      },
    });
    return { ok: true, id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[memory] memoryWrite failed:", msg);
    return { ok: false, reason: msg };
  }
}

/** Retire a fact (no replacement): stored for audit, never recalled again. */
export async function memoryRetire(
  config: Claw2Config,
  chunkId: string,
  options?: { userId?: string; isSuperuser?: boolean }
): Promise<{ ok: boolean; reason?: string }> {
  if (!config.memory?.enabled) return { ok: false, reason: "memory_disabled" };
  const store = getStore(config);
  if (typeof store.retire !== "function") {
    return { ok: false, reason: "retire_not_supported_by_backend" };
  }
  try {
    const done = await store.retire(chunkId, options);
    auditLog(config, {
      type: "memory_retire",
      details: { chunkId, ok: done },
    });
    return done ? { ok: true } : { ok: false, reason: "not_found" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[memory] memoryRetire failed:", msg);
    return { ok: false, reason: msg };
  }
}

/** Mark a fact as verified right now (memory_touch): recall stops nagging. */
export async function memoryTouch(
  config: Claw2Config,
  chunkId: string,
  options?: { userId?: string; isSuperuser?: boolean }
): Promise<{ ok: boolean; reason?: string }> {
  if (!config.memory?.enabled) return { ok: false, reason: "memory_disabled" };
  const store = getStore(config);
  if (typeof store.touch !== "function") {
    return { ok: false, reason: "touch_not_supported_by_backend" };
  }
  try {
    const done = await store.touch(chunkId, options);
    auditLog(config, { type: "memory_touch", details: { chunkId, ok: done } });
    return done ? { ok: true } : { ok: false, reason: "not_found" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[memory] memoryTouch failed:", msg);
    return { ok: false, reason: msg };
  }
}

/** A fact older than this without verification is marked stale in recall. */
export const VERIFICATION_STALE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * One memory hit as the model sees it: `[n] (source) 2026-11-22 · id=… · text`.
 * The date comes from createdAt at render time (never baked into the stored
 * text) so version ordering is mechanical; the id lets the model chain
 * remember(text, replaces=id) on later updates.
 */
export function formatMemoryHit(
  chunk: { text: string; source: MemorySource; id?: string; createdAt?: number; verifiedAt?: number },
  index?: number,
  now: number = Date.now()
): string {
  const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
  const num = typeof index === "number" ? `[${index}] ` : "";
  const id = chunk.id ? ` · id=${chunk.id}` : "";
  let when = "unknown-date";
  const verifiedAt = chunk.verifiedAt;
  const createdAt = chunk.createdAt;
  if (typeof verifiedAt === "number" && Number.isFinite(verifiedAt)) {
    when =
      now - verifiedAt > VERIFICATION_STALE_MS
        ? `проверено ${day(verifiedAt)} — УСТАРЕЛО, перепроверь (memory_touch)`
        : `проверено ${day(verifiedAt)}`;
  } else if (typeof createdAt === "number" && Number.isFinite(createdAt)) {
    when =
      now - createdAt > VERIFICATION_STALE_MS
        ? `не проверено с ${day(createdAt)} — перепроверь (memory_touch)`
        : day(createdAt);
  }
  return `${num}(${chunk.source}) ${when}${id} · ${chunk.text}`;
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
    chunks: scored.chunks.map((c) => ({
      text: c.text,
      source: c.source,
      ...(c.id ? { id: c.id } : {}),
      ...(typeof c.createdAt === "number" ? { createdAt: c.createdAt } : {}),
      ...(typeof c.verifiedAt === "number" ? { verifiedAt: c.verifiedAt } : {}),
      ...(c.untrustedOrigin ? { untrustedOrigin: true } : {}),
    })),
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
      chunks: scored.map((x) => ({
        text: x.chunk.text,
        source: x.chunk.source,
        score: x.score,
        id: x.chunk.id,
        createdAt: x.chunk.createdAt,
        verifiedAt: x.chunk.verifiedAt,
        // Provenance must survive the store→consumer seam (the anti-laundering
        // check in the orchestrator reads exactly this field).
        ...(x.chunk.untrustedOrigin ? { untrustedOrigin: true } : {}),


      })),
    };
  }
  const chunks = await store.recall(queryEmbedding, n, options);
  return {
    chunks: chunks.map((c, i) => ({
      text: c.text,
      source: c.source,
      score: Math.max(0, 1 - i * 0.08),
      id: c.id,
      createdAt: c.createdAt,
      verifiedAt: c.verifiedAt,
      ...(c.untrustedOrigin ? { untrustedOrigin: true } : {}),
    })),
  };
}
