// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Memory storage based on Chroma (persistent vector database).
 * Embeddings are calculated externally (embedding.ts); ready-made vectors are transferred here.
 * We use our own stub embedding function so as not to pull up the DefaultEmbeddingFunction
 * (@chroma-core/default-embed → onnxruntime-node) which crashes in Alpine due to missing glibc.
 */
import type { Claw2Config } from "../config/types.js";
import type { MemoryChunk } from "./store.js";
import type { IMemoryStore } from "./store.js";
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
  return chromaCollection;
}

export class ChromaStore implements IMemoryStore {
  private config: Claw2Config;
  private maxRecallChunks: number;

  constructor(config: Claw2Config) {
    this.config = config;
    this.maxRecallChunks = config.memory?.maxRecallChunks ?? 5;
  }

  async add(chunk: Omit<MemoryChunk, "id" | "createdAt">): Promise<string> {
    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const now = Date.now();
    try {
      const collection = await getCollection(this.config);
      const meta: Record<string, string> = { source: chunk.source, createdAt: String(now) };
      if (chunk.userId) meta.userId = chunk.userId;
      if (typeof chunk.importance === "number") meta.importance = String(chunk.importance);
      if (chunk.untrustedOrigin) meta.untrustedOrigin = "1";
      await collection.add({
        ids: [id],
        embeddings: [chunk.embedding],
        documents: [chunk.text],
        metadatas: [meta],
      });
      return id;
    } catch (err) {
      console.error("[memory] Chroma add failed:", err);
      throw err;
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
      if (options?.userId && !options?.isSuperuser) {
        (queryParams as { where?: Record<string, string> }).where = { userId: options.userId };
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
