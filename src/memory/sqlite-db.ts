/**
 * Shared better-sqlite3 + sqlite-vec DB for vector memory and HSS chronicle.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import type { Claw2Config } from "../config/types.js";

const require = createRequire(import.meta.url);

const META_EMBEDDING_DIM = "embedding_dim";
const META_SCHEMA_VERSION = "schema_version";
const SCHEMA_VERSION = "1";

/** Default local ONNX model dimension (Xenova/bge-small-en-v1.5). */
export const DEFAULT_LOCAL_EMBEDDING_DIM = 384;

let cachedDb: Database.Database | null = null;
let cachedPath: string | null = null;

export function resolveMemorySqlitePath(config: Claw2Config): string {
  const fromEnv = process.env.CLAW2_MEMORY_SQLITE_PATH?.trim();
  if (fromEnv) return resolve(fromEnv);
  const fromCfg = config.memory?.sqlitePath?.trim();
  if (fromCfg) return resolve(fromCfg);
  return resolve(join(process.cwd(), ".claw2", "data", "memory.sqlite"));
}

export function resolveEmbeddingDim(config: Claw2Config): number {
  const provider = resolveEmbeddingProvider(config);
  if (provider === "local") {
    const v = config.memory?.embeddingDim;
    if (typeof v === "number" && v > 0) return Math.floor(v);
    return DEFAULT_LOCAL_EMBEDDING_DIM;
  }
  const fromHss = config.orchestrator?.hssChronicleChroma?.semanticEmbeddingDim;
  if (typeof fromHss === "number" && fromHss > 0) return Math.floor(fromHss);
  const v = config.memory?.embeddingDim;
  if (typeof v === "number" && v > 0) return Math.floor(v);
  return 1024;
}

export function resolveEmbeddingProvider(config: Claw2Config): "local" | "http" {
  const env = process.env.CLAW2_MEMORY_EMBEDDING_PROVIDER?.trim().toLowerCase();
  if (env === "local" || env === "http") return env;
  const p = config.memory?.embeddingProvider;
  if (p === "local" || p === "http") return p;
  // Desktop / sqlite default → local
  if ((config.memory?.backend ?? "") === "sqlite") return "local";
  if (config.memory?.embeddingBaseURL?.trim()) return "http";
  return "http";
}

function loadSqliteVec(db: Database.Database): void {
  const sqliteVec = require("sqlite-vec") as {
    load: (db: Database.Database) => void;
    getLoadablePath?: () => string;
  };
  if (typeof sqliteVec.load === "function") {
    sqliteVec.load(db);
    return;
  }
  if (typeof sqliteVec.getLoadablePath === "function") {
    db.loadExtension(sqliteVec.getLoadablePath());
    return;
  }
  throw new Error("sqlite-vec: no load() / getLoadablePath()");
}

function getMeta(db: Database.Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM claw2_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO claw2_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

function ensureVecTables(db: Database.Database, dim: number): void {
  const existing = getMeta(db, META_EMBEDDING_DIM);
  if (existing && Number(existing) !== dim) {
    console.error(
      `[memory-sqlite] embedding dim changed ${existing} → ${dim}; recreating vector tables (data wiped)`
    );
    db.exec(`
      DROP TABLE IF EXISTS memory_vec;
      DROP TABLE IF EXISTS chronicle_vec;
      DELETE FROM memory_chunks;
      DELETE FROM hss_chronicle;
    `);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_chunks (
      id INTEGER PRIMARY KEY,
      chunk_id TEXT UNIQUE NOT NULL,
      text TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      user_id TEXT,
      importance REAL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_chunks_user ON memory_chunks(user_id);
    CREATE INDEX IF NOT EXISTS idx_memory_chunks_created ON memory_chunks(created_at);

    CREATE TABLE IF NOT EXISTS hss_chronicle (
      id INTEGER PRIMARY KEY,
      entry_id TEXT UNIQUE NOT NULL,
      session_key TEXT NOT NULL,
      context TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      entropy REAL NOT NULL,
      coherence REAL NOT NULL,
      importance REAL NOT NULL,
      entry_source TEXT NOT NULL,
      hss_emb_json TEXT,
      xi_used_json TEXT,
      rho_json TEXT,
      field_snapshot_json TEXT,
      rho_dim INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_hss_chronicle_session ON hss_chronicle(session_key);
    CREATE INDEX IF NOT EXISTS idx_hss_chronicle_ts ON hss_chronicle(timestamp);
  `);

  // vec0 cannot use IF NOT EXISTS reliably across versions — check sqlite_master
  const hasMemoryVec = db
    .prepare("SELECT 1 AS o FROM sqlite_master WHERE type='table' AND name='memory_vec'")
    .get();
  if (!hasMemoryVec) {
    db.exec(`CREATE VIRTUAL TABLE memory_vec USING vec0(embedding float[${dim}])`);
  }
  const hasChronicleVec = db
    .prepare("SELECT 1 AS o FROM sqlite_master WHERE type='table' AND name='chronicle_vec'")
    .get();
  if (!hasChronicleVec) {
    db.exec(`CREATE VIRTUAL TABLE chronicle_vec USING vec0(embedding float[${dim}])`);
  }

  setMeta(db, META_EMBEDDING_DIM, String(dim));
  setMeta(db, META_SCHEMA_VERSION, SCHEMA_VERSION);
}

/**
 * Open (or reuse) the shared memory/chronicle SQLite DB with sqlite-vec loaded.
 */
export function openMemorySqlite(config: Claw2Config): Database.Database {
  const path = resolveMemorySqlitePath(config);
  const dim = resolveEmbeddingDim(config);
  if (cachedDb && cachedPath === path) {
    ensureVecTables(cachedDb, dim);
    return cachedDb;
  }
  if (cachedDb) {
    try {
      cachedDb.close();
    } catch {
      /* ignore */
    }
    cachedDb = null;
    cachedPath = null;
  }
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  loadSqliteVec(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS claw2_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  ensureVecTables(db, dim);
  cachedDb = db;
  cachedPath = path;
  return db;
}

/** Close cached DB (tests / config backend change). */
export function closeMemorySqlite(): void {
  if (cachedDb) {
    try {
      cachedDb.close();
    } catch {
      /* ignore */
    }
  }
  cachedDb = null;
  cachedPath = null;
}

export function embeddingToMatchParam(embedding: number[]): string {
  return JSON.stringify(embedding);
}
