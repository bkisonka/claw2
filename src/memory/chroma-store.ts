// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Memory storage based on Chroma (persistent vector database).
 * Embeddings are calculated externally (embedding.ts); ready-made vectors are transferred here.
 * We use our own stub embedding function so as not to pull up the DefaultEmbeddingFunction
 * (@chroma-core/default-embed → onnxruntime-node) which crashes in Alpine due to missing glibc.
 */
import type { Claw2Config } from "../config/types.js";
import type { MemoryChunk } from "./store.js";
import type { IMemoryStore, MemoryAddOptions, MemoryRecallOptions } from "./store.js";
import type { MemorySource } from "./sanitize.js";

const DEFAULT_COLLECTION = "claw2_memory";

/** Stub: embeddings are always sent externally (Ollama), generate is not called.*/
const NOOP_EMBEDDING_FUNCTION = {
  name: "claw2-external",
  defaultSpace: () => "cosine" as const,
  supportedSpaces: (): ("cosine" | "l2" | "ip")[] => ["cosine", "l2", "ip"],
  getConfig: () => ({ name: "claw2-external" }),
  generate: async (_texts: string[]): Promise<number[][]> => {
    throw new Error("claw2: embeddings are provided externally (Ollama); generate() should not be called");
  },
};

export interface ChromaStoreOptions {
  url: string;
  collectionName?: string;
  maxRecallChunks?: number;
}

type ChromaClientInstance = InstanceType<typeof import("chromadb").ChromaClient>;
type ChromaCollection = Awaited<ReturnType<ChromaClientInstance["getOrCreateCollection"]>>;

let chromaClient: ChromaClientInstance | null = null;
let chromaCollection: ChromaCollection | null = null;
let chromaCollectionName: string | null = null;
/** One-time per process: pre-lifecycle records have no status metadata —
 *  without a backfill the recall filter (status="active") would hide them. */
let chromaStatusBackfilled = false;

async function getClient(url: string): Promise<ChromaClientInstance> {
  if (chromaClient) return chromaClient;
  const { ChromaClient } = await import("chromadb");
  chromaClient = new ChromaClient({ path: url });
  return chromaClient;
}

async function getCollection(config: Claw2Config): Promise<ChromaCollection> {
  const chroma = config.memory?.chroma;
  if (!chroma?.url?.trim()) throw new Error("memory.chroma.url required for Chroma backend");
  const name = chroma.collectionName?.trim() || DEFAULT_COLLECTION;
  if (chromaCollection && chromaCollectionName === name) return chromaCollection;
  const client = await getClient(chroma.url.trim());
  chromaCollection = await client.getOrCreateCollection({
    name,
    metadata: { "hnsw:space": "cosine" },
    embeddingFunction: NOOP_EMBEDDING_FUNCTION,
  });
  chromaCollectionName = name;
  if (!chromaStatusBackfilled) {
    chromaStatusBackfilled = true;
    try {
      const existing = await chromaCollection.get({ include: ["metadatas"] });
      const ids: string[] = [];
      const metas: Record<string, string>[] = [];
      (existing?.ids ?? []).forEach((rawId, i) => {
        const meta = existing?.metadatas?.[i];
        if (meta && typeof meta === "object" && !("status" in meta)) {
          ids.push(String(rawId));
          metas.push({ ...(meta as Record<string, string>), status: "active" });
        }
      });
      if (ids.length > 0) {
        await chromaCollection.update({ ids, metadatas: metas });
        console.error(`[memory] Chroma backfill: status=active → ${ids.length} record(s)`);
      }
    } catch (err) {
      console.error("[memory] Chroma status backfill failed:", err);
    }
  }
  return chromaCollection;
}

export class ChromaStore implements IMemoryStore {
  private config: Claw2Config;
  private maxRecallChunks: number;

  constructor(config: Claw2Config) {
    this.config = config;
    this.maxRecallChunks = config.memory?.maxRecallChunks ?? 5;
  }

  async add(chunk: Omit<MemoryChunk, "id" | "createdAt">, options?: MemoryAddOptions): Promise<string> {
    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const now = Date.now();
    try {
      const collection = await getCollection(this.config);
      const meta: Record<string, string> = { source: chunk.source, createdAt: String(now), status: "active" };
      if (chunk.userId) meta.userId = chunk.userId;
      if (typeof chunk.importance === "number") meta.importance = String(chunk.importance);
      if (chunk.untrustedOrigin) meta.untrustedOrigin = "1";
      await collection.add({
        ids: [id],
        embeddings: [chunk.embedding],
        documents: [chunk.text],
        metadatas: [meta],
      });
      // Updating a fact: retire the replaced version (metadata-only update).
      if (options?.replaces) {
        try {
          const existing = await collection.get({ ids: [options.replaces], include: ["metadatas"] });
          const oldMeta = existing?.metadatas?.[0];
          const owned =
            !!oldMeta &&
            (options.isSuperuser === true || (oldMeta.userId ?? undefined) === (chunk.userId ?? undefined));
          if (!oldMeta || !owned) {
            throw new Error(`replaces: record not found (${options.replaces})`);
          }
          await collection.update({
            ids: [options.replaces],
            metadatas: [{ ...oldMeta, status: "retired", supersededBy: id }],
          });
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("replaces:")) throw err;
          throw new Error(`replaces: record not found (${options.replaces})`);
        }
      }
      return id;
    } catch (err) {
      console.error("[memory] Chroma add failed:", err);
      throw err;
    }
  }

  /** Retire a fact without a replacement (kept in Chroma, filtered from recall). */
  async retire(chunkId: string, options?: MemoryRecallOptions): Promise<boolean> {
    try {
      const collection = await getCollection(this.config);
      const existing = await collection.get({ ids: [chunkId], include: ["metadatas"] });
      const meta = existing?.metadatas?.[0];
      const owned =
        !!meta &&
        (!options?.userId ||
          options.isSuperuser === true ||
          (meta.userId ?? undefined) === options.userId);
      if (!meta || !owned) return false;
      await collection.update({
        ids: [chunkId],
        metadatas: [{ ...meta, status: "retired" }],
      });
      return true;
    } catch (err) {
      console.error("[memory] Chroma retire failed:", err);
      return false;
    }
  }

  /** Mark a fact verified right now (memory_touch). */
  async touch(chunkId: string, options?: MemoryRecallOptions): Promise<boolean> {
    try {
      const collection = await getCollection(this.config);
      const existing = await collection.get({ ids: [chunkId], include: ["metadatas"] });
      const meta = existing?.metadatas?.[0];
      const owned =
        !!meta &&
        (!options?.userId ||
          options.isSuperuser === true ||
          (meta.userId ?? undefined) === options.userId);
      if (!meta || !owned) return false;
      await collection.update({
        ids: [chunkId],
        metadatas: [{ ...meta, verifiedAt: String(Date.now()) }],
      });
      return true;
    } catch (err) {
      console.error("[memory] Chroma touch failed:", err);
      return false;
    }
  }

  async recall(
    queryEmbedding: number[],
    limit?: number,
    options?: { userId?: string; isSuperuser?: boolean }
  ): Promise<MemoryChunk[]> {
    const scored = await this.recallScored(queryEmbedding, limit, options);
    return scored.map((x) => x.chunk);
  }

  async recallScored(
    queryEmbedding: number[],
    limit?: number,
    options?: { userId?: string; isSuperuser?: boolean }
  ): Promise<{ chunk: MemoryChunk; score: number }[]> {
    const n = limit ?? this.maxRecallChunks;
    try {
      const collection = await getCollection(this.config);
      const queryParams: Parameters<ChromaCollection["query"]>[0] = {
        queryEmbeddings: [queryEmbedding],
        nResults: Math.min(Math.max(n * 4, 12), 40),
        include: ["documents", "metadatas", "distances"],
      };
      // Only active facts surface; retired versions are history, never recall.
      if (options?.userId && !options?.isSuperuser) {
        (queryParams as { where?: Record<string, string> }).where = {
          userId: options.userId,
          status: "active",
        };
      } else {
        (queryParams as { where?: Record<string, string> }).where = { status: "active" };
      }
      const result = await collection.query(queryParams);
      const ids = result.ids?.[0] ?? [];
      const documents = result.documents?.[0] ?? [];
      const metadatas = result.metadatas?.[0] ?? [];
      const distances = result.distances?.[0] ?? [];
      const scored: { chunk: MemoryChunk; score: number }[] = [];
      for (let i = 0; i < ids.length; i++) {
        const id = String(ids[i]);
        const text = String(documents[i] ?? "");
        const meta = metadatas[i];
        const source = (meta?.source === "internal" ? "internal" : "user") as MemorySource;
        const createdAt = typeof meta?.createdAt === "string" ? Number(meta.createdAt) : Date.now();
        const userId = typeof meta?.userId === "string" ? meta.userId : undefined;
        const untrustedOrigin = typeof meta?.untrustedOrigin === "string" && meta.untrustedOrigin === "1";
        const verifiedAtRaw = typeof meta?.verifiedAt === "string" ? Number(meta.verifiedAt) : NaN;
        const verifiedAt = Number.isFinite(verifiedAtRaw) ? verifiedAtRaw : undefined;
        const importanceRaw = typeof meta?.importance === "string" ? Number(meta.importance) : 0.5;
        const importance =
          typeof importanceRaw === "number" && Number.isFinite(importanceRaw)
            ? Math.max(0, Math.min(1, importanceRaw))
            : 0.5;
        const distRaw = distances[i];
        const dist = typeof distRaw === "number" ? distRaw : 1;
        const sim = Math.max(0, 1 - dist);
        const score = sim * (0.4 + 0.6 * importance);
        scored.push({
          score,
          chunk: {
            id,
            text,
            embedding: [],
            source,
            createdAt,
            userId,
            importance,
            untrustedOrigin,
            verifiedAt,
          },
        });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, n);
    } catch (err) {
      console.error("[memory] Chroma recall failed:", err);
      return [];
    }
  }
}
