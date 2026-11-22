// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * IMemoryStore on sqlite-vec (embedded, no Chroma).
 */
import type { Claw2Config } from "../config/types.js";
import type { MemorySource } from "./sanitize.js";
import type { IMemoryStore, MemoryAddOptions, MemoryChunk, MemoryRecallOptions } from "./store.js";
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

  async add(chunk: Omit<MemoryChunk, "id" | "createdAt">, options?: MemoryAddOptions): Promise<string> {
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
      // Updating a fact: retire the replaced version in the same transaction.
      // Ownership is enforced — another user's id reads as "not found"
      // (no existence leak).
      if (options?.replaces) {
        const target = db
          .prepare("SELECT id, user_id FROM memory_chunks WHERE chunk_id = ?")
          .get(options.replaces) as { id: number; user_id: string | null } | undefined;
        const owned =
          !!target &&
          (options.isSuperuser === true || target.user_id === (chunk.userId ?? null));
        if (!target || !owned) {
          throw new Error(`replaces: record not found (${options.replaces})`);
        }
        db.prepare("UPDATE memory_chunks SET status = 'retired', superseded_by = ? WHERE id = ?").run(
          chunkId,
          target.id
        );
      }
      const info = db.prepare("INSERT INTO memory_vec(embedding) VALUES (?)").run(embParam);
      const rowid = Number(info.lastInsertRowid);
      db.prepare(
        `INSERT INTO memory_chunks(id, chunk_id, text, source, created_at, user_id, importance, origin_untrusted, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`
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

      // FIFO trim by maxChunks: retired facts are dropped first (oldest),
      // then oldest active — a fresh active fact must not be evicted by a
      // pile of retired versions.
      const count = (
        db.prepare("SELECT COUNT(*) AS n FROM memory_chunks").get() as { n: number }
      ).n;
      if (count > this.maxChunks) {
        const excess = count - this.maxChunks;
        const old = db
          .prepare(
            `SELECT id FROM memory_chunks
             ORDER BY CASE status WHEN 'retired' THEN 0 ELSE 1 END, created_at ASC
             LIMIT ?`
          )
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

  /** Retire a fact without a replacement: kept for audit, never recalled. */
  async retire(chunkId: string, options?: MemoryRecallOptions): Promise<boolean> {
    const db = openMemorySqlite(this.config);
    const target = db
      .prepare("SELECT id, user_id FROM memory_chunks WHERE chunk_id = ?")
      .get(chunkId) as { id: number; user_id: string | null } | undefined;
    const owned =
      !!target &&
      (!options?.userId ||
        options.isSuperuser === true ||
        target.user_id === options.userId);
    if (!target || !owned) return false;
    db.prepare("UPDATE memory_chunks SET status = 'retired' WHERE id = ?").run(target.id);
    return true;
  }

  /** Mark a fact verified right now (memory_touch). */
  async touch(chunkId: string, options?: MemoryRecallOptions): Promise<boolean> {
    const db = openMemorySqlite(this.config);
    const target = db
      .prepare("SELECT id, user_id FROM memory_chunks WHERE chunk_id = ?")
      .get(chunkId) as { id: number; user_id: string | null } | undefined;
    const owned =
      !!target &&
      (!options?.userId ||
        options.isSuperuser === true ||
        target.user_id === options.userId);
    if (!target || !owned) return false;
    db.prepare("UPDATE memory_chunks SET verified_at = ? WHERE id = ?").run(Date.now(), target.id);
    return true;
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
        verified_at: number | null;
        distance: number;
      }>;

      if (options?.userId && !options?.isSuperuser) {
        rows = db
          .prepare(
            `SELECT c.chunk_id, c.text, c.source, c.created_at, c.user_id, c.importance, c.origin_untrusted, c.verified_at, v.distance
             FROM memory_vec v
             JOIN memory_chunks c ON c.id = v.rowid
             WHERE v.embedding MATCH ?
               AND k = ?
               AND c.user_id = ?
               AND c.status = 'active'`
          )
          .all(q, fetchN, options.userId) as typeof rows;
      } else {
        rows = db
          .prepare(
            `SELECT c.chunk_id, c.text, c.source, c.created_at, c.user_id, c.importance, c.origin_untrusted, c.verified_at, v.distance
             FROM memory_vec v
             JOIN memory_chunks c ON c.id = v.rowid
             WHERE v.embedding MATCH ?
               AND k = ?
               AND c.status = 'active'`
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
          ...(r.verified_at != null ? { verifiedAt: r.verified_at } : {}),
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
