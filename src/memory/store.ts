// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

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
  /**
   * Fact lifecycle: "active" facts surface in recall; "retired" stay stored
   * for audit but never come back. Updating a fact retires the version it
   * replaces, so "the latest version" is chosen mechanically, not by eye.
   */
  status?: "active" | "retired";
  /** Id of the chunk that superseded this retired one. */
  supersededBy?: string;
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

export interface MemoryAddOptions {
  /**
   * chunk_id of the record this one replaces: the old version is retired
   * (status="retired", superseded_by=<new id>) in the same transaction.
   * Ownership is enforced — another user's id reads as "not found".
   */
  replaces?: string;
  /** Superuser may replace records of any user (matches recall scoping). */
  isSuperuser?: boolean;
}

/** Common memory storage interface (in-memory or Chroma).*/
export interface IMemoryStore {
  add(chunk: Omit<MemoryChunk, "id" | "createdAt">, options?: MemoryAddOptions): Promise<string>;
  recall(queryEmbedding: number[], limit?: number, options?: MemoryRecallOptions): Promise<MemoryChunk[]>;
  /** Same as recall but keeps ranking score (0..1-ish). */
  recallScored?(
    queryEmbedding: number[],
    limit?: number,
    options?: MemoryRecallOptions
  ): Promise<{ chunk: MemoryChunk; score: number }[]>;
  /** Retire a fact without a replacement (still stored, never recalled). */
  retire?(chunkId: string, options?: MemoryRecallOptions): Promise<boolean>;
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

  async add(chunk: Omit<MemoryChunk, "id" | "createdAt">, options?: MemoryAddOptions): Promise<string> {
    const id = `mem_${++this.idSeq}_${Date.now()}`;
    const now = Date.now();
    if (options?.replaces) {
      const old = this.chunks.find((c) => c.id === options.replaces);
      if (!old || !this.ownedBy(old, chunk.userId, options.isSuperuser)) {
        throw new Error(`replaces: record not found (${options.replaces})`);
      }
      old.status = "retired";
      old.supersededBy = id;
    }
    this.chunks.push({
      ...chunk,
      id,
      createdAt: now,
      userId: chunk.userId,
      status: "active",
    });
    if (this.chunks.length > this.maxChunks) {
      // Retired facts go first (oldest), then oldest active — a fresh active
      // fact must not be evicted by a pile of retired versions.
      this.chunks.sort((a, b) => a.createdAt - b.createdAt);
      const retired = this.chunks.filter((c) => c.status === "retired");
      const active = this.chunks.filter((c) => c.status !== "retired");
      const keep = [...active.slice(Math.max(0, active.length - this.maxChunks)), ...retired].slice(
        0,
        this.maxChunks
      );
      this.chunks = keep.sort((a, b) => a.createdAt - b.createdAt);
    }
    return id;
  }

  async retire(chunkId: string, options?: MemoryRecallOptions): Promise<boolean> {
    const chunk = this.chunks.find((c) => c.id === chunkId);
    if (!chunk || !this.ownedBy(chunk, options?.userId, options?.isSuperuser)) return false;
    chunk.status = "retired";
    return true;
  }

  private ownedBy(chunk: MemoryChunk, userId?: string, isSuperuser?: boolean): boolean {
    if (!userId || isSuperuser) return true;
    return chunk.userId === userId;
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
    let candidates = this.chunks.filter((c) => c.status !== "retired");
    if (options?.userId && !options?.isSuperuser) {
      candidates = candidates.filter((c) => c.userId === options.userId);
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
