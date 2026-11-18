/**
 * HSS chronicle persistence on sqlite-vec (same DB as vector memory).
 */
import type { Claw2Config } from "../config/types.js";
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
import { deserializeFieldSnapshot, type FieldSnapshot } from "./hss-field-ontology.js";
import {
  embeddingToMatchParam,
  openMemorySqlite,
  resolveEmbeddingDim,
  resolveMemorySqlitePath,
} from "../memory/sqlite-db.js";
import type {
  ChronicleEntryPayload,
  ChroniclePersistOptions,
  ChronicleRecallHit,
  ChronicleRecallOptions,
} from "./chronicle-types.js";

function sessionKey(sessionId: string, cacheId: string): string {
  return `${sessionId}:${cacheId}`;
}

function getTtlDays(config: Claw2Config): number {
  const days = config.orchestrator?.hssChronicleChroma?.ttlDays;
  return typeof days === "number" && days > 0 ? days : 0;
}

function getMinImportanceToKeep(config: Claw2Config): number {
  const v = config.orchestrator?.hssChronicleChroma?.minImportanceToKeep;
  return typeof v === "number" && v >= 0 && v <= 1 ? v : 0.9;
}

function getChronicleMaxContextChars(config: Claw2Config): number {
  const v = config.orchestrator?.hssChronicleChroma?.maxContextChars;
  return typeof v === "number" && v >= 200 ? Math.min(v, 8000) : 2000;
}

export function isChronicleSqliteConfigured(config: Claw2Config): boolean {
  return (config.memory?.backend ?? "") === "sqlite";
}

export async function persistChronicleEntrySqlite(
  config: Claw2Config,
  sessionId: string,
  cacheId: string,
  entry: ChronicleEntryPayload,
  opts?: ChroniclePersistOptions
): Promise<string | null> {
  const semanticEmbedding = opts?.semanticEmbedding;
  if (!semanticEmbedding?.length) {
    console.error("[hss-chronicle-sqlite] persist skipped: semantic embedding required");
    return null;
  }
  const dim = resolveEmbeddingDim(config);
  if (semanticEmbedding.length !== dim) {
    console.error(
      `[hss-chronicle-sqlite] dim mismatch: got ${semanticEmbedding.length}, expected ${dim}`
    );
    return null;
  }

  const db = openMemorySqlite(config);
  const maxChars = getChronicleMaxContextChars(config);
  const contextText = (entry.context ?? "").slice(0, maxChars);
  const importance = clampImportance(entry.importance, 0.5);
  const source: ChronicleEntrySource = entry.source ?? opts?.source ?? "auto";
  const hssEmb =
    entry.context_embedding?.length === HSS_CONTEXT_EMBEDDING_DIM ? entry.context_embedding : [];
  const entryId = `hss_${sessionId}_${cacheId}_${entry.timestamp}_${Math.random().toString(36).slice(2, 10)}`;
  const sk = sessionKey(sessionId, cacheId);
  const rhoDim = entry.rho_dim ?? entry.rho?.re?.length ?? 0;
  const embParam = embeddingToMatchParam(semanticEmbedding);

  try {
    const tx = db.transaction(() => {
      const info = db.prepare("INSERT INTO chronicle_vec(embedding) VALUES (?)").run(embParam);
      const rowid = Number(info.lastInsertRowid);
      db.prepare(
        `INSERT INTO hss_chronicle(
          id, entry_id, session_key, context, timestamp, entropy, coherence, importance,
          entry_source, hss_emb_json, xi_used_json, rho_json, field_snapshot_json, rho_dim
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        rowid,
        entryId,
        sk,
        contextText,
        entry.timestamp,
        entry.entropy,
        entry.coherence,
        importance,
        source,
        serializeHssEmbedding(hssEmb),
        entry.xi_used ? JSON.stringify(entry.xi_used) : "",
        entry.rho ? JSON.stringify(entry.rho) : "",
        entry.field_snapshot ? JSON.stringify(entry.field_snapshot) : "",
        rhoDim
      );
    });
    tx();
    return entryId;
  } catch (err) {
    console.error("[hss-chronicle-sqlite] add failed:", err);
    return null;
  }
}

export async function cleanupChronicleForSessionSqlite(
  config: Claw2Config,
  sessionId: string,
  cacheId: string
): Promise<number> {
  const ttlDays = getTtlDays(config);
  if (ttlDays <= 0) return 0;
  const db = openMemorySqlite(config);
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  const minImportance = getMinImportanceToKeep(config);
  const sk = sessionKey(sessionId, cacheId);
  try {
    const rows = db
      .prepare(
        `SELECT id FROM hss_chronicle
         WHERE session_key = ? AND timestamp < ? AND importance < ?`
      )
      .all(sk, cutoff, minImportance) as { id: number }[];
    const delC = db.prepare("DELETE FROM hss_chronicle WHERE id = ?");
    const delV = db.prepare("DELETE FROM chronicle_vec WHERE rowid = ?");
    const tx = db.transaction(() => {
      for (const r of rows) {
        delC.run(r.id);
        delV.run(r.id);
      }
    });
    tx();
    return rows.length;
  } catch (err) {
    console.error("[hss-chronicle-sqlite] cleanup failed:", err);
    return 0;
  }
}

function rowToEntry(row: {
  context: string;
  timestamp: number;
  entropy: number;
  coherence: number;
  importance: number;
  entry_source: string;
  hss_emb_json: string | null;
  xi_used_json: string | null;
  rho_json: string | null;
  field_snapshot_json: string | null;
  rho_dim: number | null;
}): ChronicleEntryPayload | null {
  const hssEmb = row.hss_emb_json ? deserializeHssEmbedding(row.hss_emb_json) : [];
  let xi_used: ChronicleEntryPayload["xi_used"] = null;
  if (row.xi_used_json) {
    try {
      xi_used = JSON.parse(row.xi_used_json) as ChronicleEntryPayload["xi_used"];
    } catch {
      /* ignore */
    }
  }
  let rho: ChronicleEntryPayload["rho"] = null;
  if (row.rho_json) {
    try {
      rho = JSON.parse(row.rho_json) as ChronicleEntryPayload["rho"];
    } catch {
      /* ignore */
    }
  }
  const field_snapshot: FieldSnapshot | null = row.field_snapshot_json
    ? deserializeFieldSnapshot(row.field_snapshot_json)
    : null;
  return {
    timestamp: row.timestamp,
    entropy: row.entropy,
    coherence: row.coherence,
    context: row.context,
    context_embedding: hssEmb.length === HSS_CONTEXT_EMBEDDING_DIM ? hssEmb : [],
    xi_used,
    rho,
    importance: clampImportance(row.importance, 0.5),
    source: row.entry_source === "model" ? "model" : "auto",
    field_snapshot,
    rho_dim: row.rho_dim || undefined,
  };
}

export async function loadChronicleEntriesSqlite(
  config: Claw2Config,
  sessionId: string,
  cacheId: string,
  limit = 1000
): Promise<ChronicleEntryPayload[]> {
  const db = openMemorySqlite(config);
  const sk = sessionKey(sessionId, cacheId);
  try {
    const rows = db
      .prepare(
        `SELECT context, timestamp, entropy, coherence, importance, entry_source,
                hss_emb_json, xi_used_json, rho_json, field_snapshot_json, rho_dim
         FROM hss_chronicle
         WHERE session_key = ?
         ORDER BY timestamp ASC`
      )
      .all(sk) as Array<Parameters<typeof rowToEntry>[0]>;

    const entries: ChronicleEntryPayload[] = [];
    for (const row of rows) {
      const parsed = rowToEntry(row);
      if (parsed) entries.push(parsed);
    }
    const out = entries.slice(-limit);
    if (getTtlDays(config) > 0) {
      cleanupChronicleForSessionSqlite(config, sessionId, cacheId).catch(() => {});
    }
    return out;
  } catch (err) {
    console.error("[hss-chronicle-sqlite] load failed:", err);
    return [];
  }
}

export async function recallChronicleEntriesSqlite(
  config: Claw2Config,
  sessionId: string,
  cacheId: string,
  queryEmbedding: number[],
  options?: ChronicleRecallOptions
): Promise<ChronicleRecallHit[]> {
  if (!queryEmbedding.length) return [];
  const db = openMemorySqlite(config);
  const dim = resolveEmbeddingDim(config);
  if (queryEmbedding.length !== dim) {
    console.error(
      `[hss-chronicle-sqlite] recall dim mismatch query=${queryEmbedding.length} expected=${dim}`
    );
    return [];
  }

  const recallCfg = config.orchestrator?.hssChronicleRecall;
  const limit = options?.limit ?? recallCfg?.maxEntries ?? 5;
  const minSimilarity = options?.minSimilarity ?? recallCfg?.minSimilarity ?? 0.2;
  const pinMin = options?.pinImportanceMin ?? recallCfg?.pinImportanceMin ?? 0.85;
  const maxPinned = options?.maxPinned ?? recallCfg?.maxPinnedEntries ?? 3;
  const sk = sessionKey(sessionId, cacheId);
  const fetchN = Math.min(Math.max(limit * 4, 12), 50);
  const q = embeddingToMatchParam(queryEmbedding);
  const byId = new Map<string, ChronicleRecallHit>();

  try {
    const rows = db
      .prepare(
        `SELECT c.entry_id, c.context, c.timestamp, c.entropy, c.coherence, c.importance,
                c.entry_source, v.distance
         FROM chronicle_vec v
         JOIN hss_chronicle c ON c.id = v.rowid
         WHERE v.embedding MATCH ?
           AND k = ?
           AND c.session_key = ?`
      )
      .all(q, fetchN, sk) as Array<{
      entry_id: string;
      context: string;
      timestamp: number;
      entropy: number;
      coherence: number;
      importance: number;
      entry_source: string;
      distance: number;
    }>;

    for (const r of rows) {
      const dist = typeof r.distance === "number" ? r.distance : 1;
      const similarity = Math.max(0, 1 - dist);
      if (similarity < minSimilarity) continue;
      const context = (r.context ?? "").trim();
      if (!context) continue;
      const importance = clampImportance(r.importance, 0.5);
      const source: ChronicleEntrySource = r.entry_source === "model" ? "model" : "auto";
      const hit: ChronicleRecallHit = {
        id: r.entry_id,
        context,
        importance,
        timestamp: r.timestamp,
        entropy: r.entropy,
        coherence: r.coherence,
        source,
        similarity,
        score: chronicleRecallScore(similarity, importance, config),
        pinned: false,
      };
      byId.set(hit.id, hit);
    }

    const pinnedRows = db
      .prepare(
        `SELECT entry_id, context, timestamp, entropy, coherence, importance, entry_source
         FROM hss_chronicle
         WHERE session_key = ? AND importance >= ?
         ORDER BY importance DESC, timestamp DESC
         LIMIT ?`
      )
      .all(sk, pinMin, maxPinned * 3) as Array<{
      entry_id: string;
      context: string;
      timestamp: number;
      entropy: number;
      coherence: number;
      importance: number;
      entry_source: string;
    }>;

    const pinned: ChronicleRecallHit[] = [];
    for (const r of pinnedRows) {
      const context = (r.context ?? "").trim();
      if (!context) continue;
      const importance = clampImportance(r.importance, 0.5);
      pinned.push({
        id: r.entry_id,
        context,
        importance,
        timestamp: r.timestamp,
        entropy: r.entropy,
        coherence: r.coherence,
        source: r.entry_source === "model" ? "model" : "auto",
        similarity: 1,
        score: chronicleRecallScore(1, importance, config),
        pinned: true,
      });
    }
    pinned.sort((a, b) => b.importance - a.importance || b.timestamp - a.timestamp);
    for (const p of pinned.slice(0, maxPinned)) {
      const existing = byId.get(p.id);
      if (existing) {
        existing.pinned = true;
        existing.score = Math.max(existing.score, p.score);
      } else {
        byId.set(p.id, p);
      }
    }

    return [...byId.values()]
      .sort((a, b) => b.score - a.score || b.timestamp - a.timestamp)
      .slice(0, limit + maxPinned);
  } catch (err) {
    console.error("[hss-chronicle-sqlite] recall failed:", err);
    return [];
  }
}

/** For health checks. */
export function probeChronicleSqlite(config: Claw2Config): { ok: boolean; path: string; error?: string } {
  try {
    const path = resolveMemorySqlitePath(config);
    openMemorySqlite(config);
    return { ok: true, path };
  } catch (err) {
    return {
      ok: false,
      path: resolveMemorySqlitePath(config),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
