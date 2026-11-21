// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Persistence and semantic recall of HSS chronicles in Chroma (legacy).
 * When memory.backend=sqlite delegates to chronicle-sqlite.
 */

import type { Claw2Config } from "../config/types.js";
import { resolveEmbeddingDim } from "../memory/sqlite-db.js";
import {
  clampImportance,
  chronicleRecallScore,
  type ChronicleEntrySource,
} from "./chronicle-importance.js";
import {
  deserializeHssEmbedding,
  HSS_CONTEXT_EMBEDDING_DIM,
  serializeHssEmbedding,
} from "./hss-context-encoder.js";
import { deserializeFieldSnapshot } from "./hss-field-ontology.js";
import type {
  ChronicleEntryPayload,
  ChroniclePersistOptions,
  ChronicleRecallHit,
  ChronicleRecallOptions,
} from "./chronicle-types.js";
import {
  cleanupChronicleForSessionSqlite,
  isChronicleSqliteConfigured,
  loadChronicleEntriesSqlite,
  persistChronicleEntrySqlite,
  recallChronicleEntriesSqlite,
} from "./chronicle-sqlite.js";

export type {
  ChronicleEntryPayload,
  ChroniclePersistOptions,
  ChronicleRecallHit,
  ChronicleRecallOptions,
} from "./chronicle-types.js";

const DEFAULT_CHRONICLE_COLLECTION = "claw2_hss_chronicle";
const DEFAULT_MAX_CONTEXT_CHARS = 2000;

type ChromaClientInstance = InstanceType<typeof import("chromadb").ChromaClient>;
type ChromaCollection = Awaited<ReturnType<ChromaClientInstance["getOrCreateCollection"]>>;

let chronicleClient: ChromaClientInstance | null = null;
let chronicleCollection: ChromaCollection | null = null;
let chronicleCollectionName: string | null = null;
let chronicleUrl: string | null = null;

const NOOP_EMBEDDING = {
  name: "claw2-hss-chronicle",
  defaultSpace: () => "cosine" as const,
  supportedSpaces: (): ("cosine" | "l2" | "ip")[] => ["cosine", "l2", "ip"],
  getConfig: () => ({ name: "claw2-hss-chronicle" }),
  generate: async (): Promise<number[][]> => {
    throw new Error("HSS chronicle: embeddings provided externally");
  },
};

function getChronicleChromaUrl(config: Claw2Config): string | null {
  const hss = config.orchestrator?.hssChronicleChroma;
  if (hss?.url?.trim()) return hss.url.trim();
  const memory = config.memory?.chroma?.url?.trim();
  return memory ?? null;
}

function getChronicleCollectionName(config: Claw2Config): string {
  const hss = config.orchestrator?.hssChronicleChroma?.collectionName?.trim();
  if (hss) return hss;
  return DEFAULT_CHRONICLE_COLLECTION;
}

export function getSemanticEmbeddingDim(config: Claw2Config): number {
  return resolveEmbeddingDim(config);
}

function isDimensionMismatchError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /expecting embedding with dimension of \d+, got \d+/i.test(msg);
}

async function fetchCollectionDimension(chromaUrl: string, collectionName: string): Promise<number | null> {
  const base = chromaUrl.replace(/\/$/, "");
  const url = `${base}/api/v2/tenants/default_tenant/databases/default_database/collections/${encodeURIComponent(collectionName)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { dimension?: number };
    return typeof data.dimension === "number" ? data.dimension : null;
  } catch {
    return null;
  }
}

async function recreateChronicleCollection(
  client: ChromaClientInstance,
  name: string,
  expectedDim: number,
  reason: string
): Promise<ChromaCollection> {
  console.error(
    `[hss-chronicle] recreating collection "${name}" for semantic dim ${expectedDim} (${reason})`
  );
  try {
    await client.deleteCollection({ name });
  } catch {
    // collection may not exist yet
  }
  chronicleCollection = null;
  return client.getOrCreateCollection({
    name,
    metadata: {
      "hnsw:space": "cosine",
      claw2_semantic_dim: String(expectedDim),
      claw2_embedding_kind: "semantic",
    },
    embeddingFunction: NOOP_EMBEDDING,
  });
}

function getTtlDays(config: Claw2Config): number {
  const days = config.orchestrator?.hssChronicleChroma?.ttlDays;
  return typeof days === "number" && days > 0 ? days : 0;
}

function getMinImportanceToKeep(config: Claw2Config): number {
  const v = config.orchestrator?.hssChronicleChroma?.minImportanceToKeep;
  return typeof v === "number" && v >= 0 && v <= 1 ? v : 0.9;
}

export function getChronicleMaxContextChars(config: Claw2Config): number {
  const v = config.orchestrator?.hssChronicleChroma?.maxContextChars;
  return typeof v === "number" && v >= 200 ? Math.min(v, 8000) : DEFAULT_MAX_CONTEXT_CHARS;
}

function sessionKey(sessionId: string, cacheId: string): string {
  return `${sessionId}:${cacheId}`;
}

function metaAsRecord(meta: unknown): Record<string, string | number | boolean> | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

async function getChronicleCollection(config: Claw2Config): Promise<ChromaCollection | null> {
  const url = getChronicleChromaUrl(config);
  if (!url) return null;
  const name = getChronicleCollectionName(config);
  const expectedDim = getSemanticEmbeddingDim(config);
  if (
    chronicleCollection &&
    chronicleCollectionName === name &&
    chronicleUrl === url
  ) {
    return chronicleCollection;
  }
  try {
    const { ChromaClient } = await import("chromadb");
    if (!chronicleClient || chronicleUrl !== url) {
      chronicleClient = new ChromaClient({ path: url });
      chronicleUrl = url;
    }
    const existingDim = await fetchCollectionDimension(url, name);
    if (existingDim != null && existingDim !== expectedDim) {
      chronicleCollection = await recreateChronicleCollection(
        chronicleClient,
        name,
        expectedDim,
        `was ${existingDim}`
      );
    } else {
      chronicleCollection = await chronicleClient.getOrCreateCollection({
        name,
        metadata: {
          "hnsw:space": "cosine",
          claw2_semantic_dim: String(expectedDim),
          claw2_embedding_kind: "semantic",
        },
        embeddingFunction: NOOP_EMBEDDING,
      });
    }
    chronicleCollectionName = name;
    return chronicleCollection;
  } catch (err) {
    console.error("[hss-chronicle] Chroma connection failed:", err);
    return null;
  }
}

function parseEntryFromChromaRow(
  document: string | null | undefined,
  embedding: number[] | null | undefined,
  meta: Record<string, string | number | boolean> | null | undefined
): ChronicleEntryPayload | null {
  if (!meta) return null;
  const timestamp = Number(meta.timestamp_num ?? meta.timestamp) || 0;
  if (!timestamp) return null;
  const entropy = Number(meta.entropy) || 0;
  const coherence = Number(meta.coherence) || 0;
  const context = String(document ?? "");
  const importance = clampImportance(meta.importance, 0.5);
  const hssEmb =
    typeof meta.hss_emb_json === "string"
      ? deserializeHssEmbedding(meta.hss_emb_json)
      : Array.isArray(embedding) && embedding.length === HSS_CONTEXT_EMBEDDING_DIM
        ? (embedding as number[])
        : [];
  let xi_used: { re: number[][]; im: number[][] } | null = null;
  const xiJson = meta.xi_used_json;
  if (typeof xiJson === "string" && xiJson) {
    try {
      xi_used = JSON.parse(xiJson) as { re: number[][]; im: number[][] };
    } catch {
      // ignore
    }
  }
  let rho: { re: number[][]; im: number[][] } | null = null;
  const rhoJson = meta.rho_json;
  if (typeof rhoJson === "string" && rhoJson) {
    try {
      rho = JSON.parse(rhoJson) as { re: number[][]; im: number[][] };
    } catch {
      // ignore
    }
  }
  const source: ChronicleEntrySource = meta.entry_source === "model" ? "model" : "auto";
  const field_snapshot =
    typeof meta.field_snapshot_json === "string"
      ? deserializeFieldSnapshot(meta.field_snapshot_json)
      : null;
  const rho_dim = Number(meta.rho_dim) || (rho?.re?.length ?? 0) || undefined;
  return {
    timestamp,
    entropy,
    coherence,
    context,
    context_embedding: hssEmb.length === HSS_CONTEXT_EMBEDDING_DIM ? hssEmb : [],
    xi_used,
    rho,
    importance,
    source,
    field_snapshot,
    rho_dim: rho_dim || undefined,
  };
}

function parseRecallHit(
  id: string,
  document: string | null | undefined,
  meta: Record<string, string | number | boolean> | null | undefined,
  similarity: number,
  config: Claw2Config,
  pinned: boolean
): ChronicleRecallHit | null {
  if (!meta) return null;
  const timestamp = Number(meta.timestamp_num ?? meta.timestamp) || 0;
  const importance = clampImportance(meta.importance, 0.5);
  const source: ChronicleEntrySource = meta.entry_source === "model" ? "model" : "auto";
  const context = String(document ?? "").trim();
  if (!context) return null;
  return {
    id: String(id),
    context,
    importance,
    timestamp,
    entropy: Number(meta.entropy) || 0,
    coherence: Number(meta.coherence) || 0,
    source,
    similarity,
    score: chronicleRecallScore(similarity, importance, config),
    pinned,
  };
}

/**
 * Save a timeline entry in Chroma.
 * semanticEmbedding - the main vector for recall; hss_emb_json - 64-dim for the HSS node.
 */
export async function persistChronicleEntry(
  config: Claw2Config,
  sessionId: string,
  cacheId: string,
  entry: ChronicleEntryPayload,
  opts?: ChroniclePersistOptions
): Promise<string | null> {
  if (isChronicleSqliteConfigured(config)) {
    return persistChronicleEntrySqlite(config, sessionId, cacheId, entry, opts);
  }
  const collection = await getChronicleCollection(config);
  if (!collection) return null;

  const maxChars = getChronicleMaxContextChars(config);
  const contextText = (entry.context ?? "").slice(0, maxChars);
  const importance = clampImportance(entry.importance, 0.5);
  const source: ChronicleEntrySource = entry.source ?? opts?.source ?? "auto";
  const hssEmb =
    entry.context_embedding?.length === HSS_CONTEXT_EMBEDDING_DIM ? entry.context_embedding : [];
  const semanticEmbedding = opts?.semanticEmbedding;
  if (!semanticEmbedding?.length) {
    console.error("[hss-chronicle] persist skipped: semantic embedding required");
    return null;
  }

  const id = `hss_${sessionId}_${cacheId}_${entry.timestamp}_${Math.random().toString(36).slice(2, 10)}`;
  const xiJson = entry.xi_used ? JSON.stringify(entry.xi_used) : "";
  const rhoJson = entry.rho ? JSON.stringify(entry.rho) : "";
  const fieldJson = entry.field_snapshot ? JSON.stringify(entry.field_snapshot) : "";
  const sk = sessionKey(sessionId, cacheId);
  const rhoDim = entry.rho_dim ?? entry.rho?.re?.length ?? 0;

  const addOnce = async (target: ChromaCollection): Promise<void> => {
    await target.add({
      ids: [id],
      embeddings: [semanticEmbedding],
      documents: [contextText],
      metadatas: [
        {
          sessionKey: sk,
          timestamp: String(entry.timestamp),
          timestamp_num: String(entry.timestamp),
          entropy: String(entry.entropy),
          coherence: String(entry.coherence),
          xi_used_json: xiJson,
          rho_json: rhoJson,
          importance: String(importance),
          entry_source: source,
          hss_emb_json: serializeHssEmbedding(hssEmb),
          embedding_kind: "semantic",
          field_snapshot_json: fieldJson,
          rho_dim: String(rhoDim),
        },
      ],
    });
  };

  try {
    await addOnce(collection);
    return id;
  } catch (err) {
    if (!isDimensionMismatchError(err)) {
      console.error("[hss-chronicle] add failed:", err);
      return null;
    }
    const url = getChronicleChromaUrl(config);
    const name = getChronicleCollectionName(config);
    const expectedDim = getSemanticEmbeddingDim(config);
    if (!url || !chronicleClient) {
      console.error("[hss-chronicle] add failed (dimension mismatch, no client):", err);
      return null;
    }
    try {
      chronicleCollection = await recreateChronicleCollection(
        chronicleClient,
        name,
        expectedDim,
        "add dimension mismatch"
      );
      chronicleCollectionName = name;
      await addOnce(chronicleCollection);
      return id;
    } catch (retryErr) {
      console.error("[hss-chronicle] add failed after recreate:", retryErr);
      return null;
    }
  }
}

export async function cleanupChronicleForSession(
  config: Claw2Config,
  sessionId: string,
  cacheId: string
): Promise<number> {
  if (isChronicleSqliteConfigured(config)) {
    return cleanupChronicleForSessionSqlite(config, sessionId, cacheId);
  }
  const ttlDays = getTtlDays(config);
  if (ttlDays <= 0) return 0;
  const collection = await getChronicleCollection(config);
  if (!collection) return 0;

  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  const minImportance = getMinImportanceToKeep(config);
  const sk = sessionKey(sessionId, cacheId);

  try {
    const result = await collection.get({
      where: { sessionKey: sk },
      include: ["metadatas"],
      limit: 50000,
    });
    const ids = result.ids ?? [];
    const metadatas = result.metadatas ?? [];
    const toDelete: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const meta = metadatas[i];
      const ts = Number(meta?.timestamp_num ?? meta?.timestamp) || 0;
      const importance = Number(meta?.importance) || 0;
      if (ts > 0 && ts < cutoff && importance < minImportance) toDelete.push(String(ids[i]));
    }
    if (toDelete.length > 0) {
      await collection.delete({ ids: toDelete });
    }
    return toDelete.length;
  } catch (err) {
    console.error("[hss-chronicle] cleanup failed:", err);
    return 0;
  }
}

export async function loadChronicleEntries(
  config: Claw2Config,
  sessionId: string,
  cacheId: string,
  limit = 1000
): Promise<ChronicleEntryPayload[]> {
  if (isChronicleSqliteConfigured(config)) {
    return loadChronicleEntriesSqlite(config, sessionId, cacheId, limit);
  }
  const collection = await getChronicleCollection(config);
  if (!collection) return [];

  try {
    const sk = sessionKey(sessionId, cacheId);
    const result = await collection.get({
      where: { sessionKey: sk },
      include: ["embeddings", "documents", "metadatas"],
      limit: limit + 500,
    });

    const ids = result.ids ?? [];
    const embeddings = result.embeddings ?? [];
    const documents = result.documents ?? [];
    const metadatas = result.metadatas ?? [];

    const entries: ChronicleEntryPayload[] = [];
    for (let i = 0; i < ids.length; i++) {
      const emb = Array.isArray(embeddings[i]) ? (embeddings[i] as number[]) : [];
      const parsed = parseEntryFromChromaRow(documents[i], emb, metaAsRecord(metadatas[i]));
      if (parsed) entries.push(parsed);
    }

    entries.sort((a, b) => a.timestamp - b.timestamp);
    const out = entries.slice(-limit);

    if (getTtlDays(config) > 0) {
      cleanupChronicleForSession(config, sessionId, cacheId).catch(() => {});
    }
    return out;
  } catch (err) {
    console.error("[hss-chronicle] load failed:", err);
    return [];
  }
}

/**
 * Semantic recall of session chronicles: similarity + boost by importance.
 * Entries with importance >= pinImportanceMin are included as pinned (even with low similarity).
 */
export async function recallChronicleEntries(
  config: Claw2Config,
  sessionId: string,
  cacheId: string,
  queryEmbedding: number[],
  options?: ChronicleRecallOptions
): Promise<ChronicleRecallHit[]> {
  if (isChronicleSqliteConfigured(config)) {
    return recallChronicleEntriesSqlite(config, sessionId, cacheId, queryEmbedding, options);
  }
  const collection = await getChronicleCollection(config);
  if (!collection || !queryEmbedding.length) return [];

  const recallCfg = config.orchestrator?.hssChronicleRecall;
  const limit = options?.limit ?? recallCfg?.maxEntries ?? 5;
  const minSimilarity = options?.minSimilarity ?? recallCfg?.minSimilarity ?? 0.2;
  const pinMin = options?.pinImportanceMin ?? recallCfg?.pinImportanceMin ?? 0.85;
  const maxPinned = options?.maxPinned ?? recallCfg?.maxPinnedEntries ?? 3;
  const sk = sessionKey(sessionId, cacheId);

  const byId = new Map<string, ChronicleRecallHit>();

  try {
    const queryParams: Parameters<ChromaCollection["query"]>[0] = {
      queryEmbeddings: [queryEmbedding],
      nResults: Math.min(Math.max(limit * 4, 12), 50),
      include: ["documents", "metadatas", "distances"],
      where: { sessionKey: sk },
    };
    const result = await collection.query(queryParams);
    const ids = result.ids?.[0] ?? [];
    const documents = result.documents?.[0] ?? [];
    const metadatas = result.metadatas?.[0] ?? [];
    const distances = result.distances?.[0] ?? [];

    for (let i = 0; i < ids.length; i++) {
      const distRaw = distances[i];
      const dist = typeof distRaw === "number" ? distRaw : 1;
      const similarity = Math.max(0, 1 - dist);
      if (similarity < minSimilarity) continue;
      const hit = parseRecallHit(
        String(ids[i]),
        documents[i],
        metaAsRecord(metadatas[i]),
        similarity,
        config,
        false
      );
      if (hit) byId.set(hit.id, hit);
    }

    const pinnedResult = await collection.get({
      where: { sessionKey: sk },
      include: ["documents", "metadatas"],
      limit: 500,
    });
    const pinnedCandidates: ChronicleRecallHit[] = [];
    const pIds = pinnedResult.ids ?? [];
    const pDocs = pinnedResult.documents ?? [];
    const pMeta = pinnedResult.metadatas ?? [];
    for (let i = 0; i < pIds.length; i++) {
      const imp = clampImportance(pMeta[i]?.importance, 0);
      if (imp < pinMin) continue;
      const hit = parseRecallHit(
        String(pIds[i]),
        pDocs[i],
        metaAsRecord(pMeta[i]),
        1,
        config,
        true
      );
      if (hit) pinnedCandidates.push(hit);
    }
    pinnedCandidates.sort((a, b) => b.importance - a.importance || b.timestamp - a.timestamp);
    for (const hit of pinnedCandidates.slice(0, maxPinned)) {
      if (!byId.has(hit.id)) byId.set(hit.id, hit);
    }

    const merged = [...byId.values()];
    merged.sort((a, b) => b.score - a.score || b.importance - a.importance || b.timestamp - a.timestamp);
    return merged.slice(0, limit);
  } catch (err) {
    console.error("[hss-chronicle] recall failed:", err);
    return [];
  }
}

/** True if chronicle can persist (sqlite memory backend or Chroma URL). */
export function isChronicleStoreConfigured(config: Claw2Config): boolean {
  if (isChronicleSqliteConfigured(config)) return true;
  return !!getChronicleChromaUrl(config);
}

/** @deprecated Prefer isChronicleStoreConfigured — kept for callers. */
export function isChronicleChromaConfigured(config: Claw2Config): boolean {
  return isChronicleStoreConfigured(config);
}

export function isChronicleRecallEnabled(config: Claw2Config): boolean {
  if (!isChronicleStoreConfigured(config)) return false;
  return config.orchestrator?.hssChronicleRecall?.enabled !== false;
}
