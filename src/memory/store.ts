import type { MemorySource } from "./sanitize.js";
import { similarity } from "./embedding.js";

export interface MemoryChunk {
  id: string;
  text: string;
  embedding: number[];
  source: MemorySource;
  createdAt: number;
  /** Recognized user ID (vision); to isolate memory between users*/
  userId?: string;
  /** Importance 0..1; sets the model for remember. Affects recall.*/
  importance?: number;
  /**
   * True when this chunk derives from untrusted-origin content (written
   * during a trifecta-armed turn). Recalling such a chunk must arm the
   * reading session's taint ledger (security/origin.ts) — otherwise
   * untrusted content re-enters later sessions labeled "internal".
   */
  untrustedOrigin?: boolean;
}

const DEFAULT_MAX_CHUNKS = 500;
const DEFAULT_MAX_RECALL = 5;

export interface MemoryStoreOptions {
  maxChunks?: number;
  maxRecallChunks?: number;
}

export interface MemoryRecallOptions {
  userId?: string;
  isSuperuser?: boolean;
}

/** Common memory storage interface (in-memory or Chroma).*/
export interface IMemoryStore {
  add(chunk: Omit<MemoryChunk, "id" | "createdAt">): Promise<string>;
  recall(queryEmbedding: number[], limit?: number, options?: MemoryRecallOptions): Promise<MemoryChunk[]>;
  /** Same as recall but keeps ranking score (0..1-ish). */
  recallScored?(
    queryEmbedding: number[],
    limit?: number,
    options?: MemoryRecallOptions
  ): Promise<{ chunk: MemoryChunk; score: number }[]>;
}

export class InMemoryStore implements IMemoryStore {
  private chunks: MemoryChunk[] = [];
  private maxChunks: number;
  private maxRecallChunks: number;
  private idSeq = 0;

  constructor(options: MemoryStoreOptions = {}) {
    this.maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;
    this.maxRecallChunks = options.maxRecallChunks ?? DEFAULT_MAX_RECALL;
  }

  async add(chunk: Omit<MemoryChunk, "id" | "createdAt">): Promise<string> {
    const id = `mem_${++this.idSeq}_${Date.now()}`;
    const now = Date.now();
    this.chunks.push({
      ...chunk,
      id,
      createdAt: now,
      userId: chunk.userId,
    });
    if (this.chunks.length > this.maxChunks) {
      this.chunks.sort((a, b) => a.createdAt - b.createdAt);
      this.chunks = this.chunks.slice(-this.maxChunks);
    }
    return id;
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
    let candidates = this.chunks;
    if (options?.userId && !options?.isSuperuser) {
      candidates = this.chunks.filter((c) => c.userId === options.userId);
    }
    if (candidates.length === 0) return [];
    const withScore = candidates.map((c) => {
      const imp = typeof c.importance === "number" ? Math.max(0, Math.min(1, c.importance)) : 0.5;
      const raw = similarity(c.embedding, queryEmbedding);
      return { chunk: c, score: raw * (0.4 + 0.6 * imp) };
    });
    withScore.sort((a, b) => b.score - a.score);
    return withScore.slice(0, n);
  }
}
