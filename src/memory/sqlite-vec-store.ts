// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * IMemoryStore on sqlite-vec (embedded, no Chroma).
 */
import type { Claw2Config } from "../config/types.js";
import type { MemorySource } from "./sanitize.js";
import type { IMemoryStore, MemoryChunk, MemoryRecallOptions } from "./store.js";
import {
  embeddingToMatchParam,
  openMemorySqlite,
  resolveEmbeddingDim,
} from "./sqlite-db.js";

export class SqliteVecStore implements IMemoryStore {
  private config: Claw2Config;
  private maxChunks: number;
  private maxRecallChunks: number;

  constructor(config: Claw2Config) {
    this.config = config;
    this.maxChunks = config.memory?.maxChunks ?? 500;
    this.maxRecallChunks = config.memory?.maxRecallChunks ?? 5;
  }

  async add(chunk: Omit<MemoryChunk, "id" | "createdAt">): Promise<string> {
    const db = openMemorySqlite(this.config);
    const dim = resolveEmbeddingDim(this.config);
    if (chunk.embedding.length !== dim) {
      throw new Error(
        `Embedding dim mismatch: got ${chunk.embedding.length}, expected ${dim} (memory.embeddingDim / local model)`
      );
    }
    const chunkId = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const now = Date.now();
    const embParam = embeddingToMatchParam(chunk.embedding);

    const tx = db.transaction(() => {
      const info = db.prepare("INSERT INTO memory_vec(embedding) VALUES (?)").run(embParam);
      const rowid = Number(info.lastInsertRowid);
      db.prepare(
        `INSERT INTO memory_chunks(id, chunk_id, text, source, created_at, user_id, importance, origin_untrusted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        rowid,
        chunkId,
        chunk.text,
        chunk.source,
        now,
        chunk.userId ?? null,
        typeof chunk.importance === "number" ? chunk.importance : 0.5,
        chunk.untrustedOrigin === true ? 1 : 0
      );

      // FIFO trim by maxChunks
      const count = (
        db.prepare("SELECT COUNT(*) AS n FROM memory_chunks").get() as { n: number }
      ).n;
      if (count > this.maxChunks) {
        const excess = count - this.maxChunks;
        const old = db
          .prepare("SELECT id FROM memory_chunks ORDER BY created_at ASC LIMIT ?")
          .all(excess) as { id: number }[];
        const delChunk = db.prepare("DELETE FROM memory_chunks WHERE id = ?");
        const delVec = db.prepare("DELETE FROM memory_vec WHERE rowid = ?");
        for (const row of old) {
          delChunk.run(row.id);
          delVec.run(row.id);
        }
      }
    });
    tx();
    return chunkId;
  }

  async recall(
    queryEmbedding: number[],
    limit?: number,
    options?: MemoryRecallOptions
  ): Promise<MemoryChunk[]> {
    const scored = await this.recallScored(queryEmbedding, limit, options);
    return scored.map((x) => x.chunk);
  }

  async recallScored(
    queryEmbedding: number[],
    limit?: number,
    options?: MemoryRecallOptions
  ): Promise<{ chunk: MemoryChunk; score: number }[]> {
    const n = limit ?? this.maxRecallChunks;
    if (!queryEmbedding.length) return [];
    const db = openMemorySqlite(this.config);
    const dim = resolveEmbeddingDim(this.config);
    if (queryEmbedding.length !== dim) {
      console.error(
        `[memory-sqlite] recall dim mismatch: query=${queryEmbedding.length} expected=${dim}`
      );
      return [];
    }

    const fetchN = Math.min(Math.max(n * 4, 12), 80);
    const q = embeddingToMatchParam(queryEmbedding);

    try {
      let rows: Array<{
        chunk_id: string;
        text: string;
        source: string;
        created_at: number;
        user_id: string | null;
            origin_untrusted: number | null;
        importance: number | null;
        distance: number;
      }>;

      if (options?.userId && !options?.isSuperuser) {
        rows = db
          .prepare(
            `SELECT c.chunk_id, c.text, c.source, c.created_at, c.user_id, c.importance, c.origin_untrusted, v.distance
             FROM memory_vec v
             JOIN memory_chunks c ON c.id = v.rowid
             WHERE v.embedding MATCH ?
               AND k = ?
               AND c.user_id = ?`
          )
          .all(q, fetchN, options.userId) as typeof rows;
      } else {
        rows = db
          .prepare(
            `SELECT c.chunk_id, c.text, c.source, c.created_at, c.user_id, c.importance, c.origin_untrusted, v.distance
             FROM memory_vec v
             JOIN memory_chunks c ON c.id = v.rowid
             WHERE v.embedding MATCH ?
               AND k = ?`
          )
          .all(q, fetchN) as typeof rows;
      }

      const scored = rows.map((r) => {
        const importance =
          typeof r.importance === "number" && Number.isFinite(r.importance)
            ? Math.max(0, Math.min(1, r.importance))
            : 0.5;
        const dist = typeof r.distance === "number" ? r.distance : 1;
        const sim = Math.max(0, 1 - dist);
        const score = sim * (0.4 + 0.6 * importance);
        const chunk: MemoryChunk = {
          id: r.chunk_id,
          text: r.text,
          embedding: [],
          source: (r.source === "internal" ? "internal" : "user") as MemorySource,
          createdAt: r.created_at,
          userId: r.user_id ?? undefined,
          importance,
          untrustedOrigin: r.origin_untrusted === 1,
        };
        return { chunk, score };
      });
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, n);
    } catch (err) {
      console.error("[memory-sqlite] recall failed:", err);
      return [];
    }
  }
}
