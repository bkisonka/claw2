// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Agent natural selection repository: SQLite (agent-selection.db).
 * Scheme: tasks, versions, runs. Migration on first opening.
 */
import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Claw2Config } from "../config/types.js";
import { selectionLog } from "./log.js";
import type { AgentSelectionVersion, VersionWithRunCount } from "./types.js";

const DEFAULT_DB_FILENAME = "agent-selection.db";

function getDbPath(customPath?: string): string {
  if (customPath?.trim()) return resolve(customPath.trim());
  const stateDir = process.env.CLAW2_STATE_DIR?.trim() || ".claw2";
  return resolve(process.cwd(), stateDir, DEFAULT_DB_FILENAME);
}

function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

const MIGRATION = `-- Task = selection niche (taskId = hash from toolName + inputSchema).
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  input_schema_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

-- Agent version: code, creation date, drop date (null is currently active).
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  dropped_at TEXT
);

-- Launch version: time, duration, success/error, optional evaluation.
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id TEXT NOT NULL REFERENCES versions(id),
  timestamp TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  success INTEGER NOT NULL,
  error_type TEXT,
  rating REAL
);

CREATE INDEX IF NOT EXISTS idx_versions_task_id ON versions(task_id);
CREATE INDEX IF NOT EXISTS idx_versions_dropped_at ON versions(dropped_at);
CREATE INDEX IF NOT EXISTS idx_runs_version_id ON runs(version_id);`;

let dbInstance: Database.Database | null = null;

/** Get a connection to the database (migration on first call).*/
export function getDb(config: { agentSelection?: { dbPath?: string } }): Database.Database {
  if (dbInstance) return dbInstance;
  const path = getDbPath(config.agentSelection?.dbPath);
  ensureDir(path);
  dbInstance = new Database(path);
  dbInstance.exec(MIGRATION);
  return dbInstance;
}

/** Path to the database file (for CLI and config).*/
export function getStoreDbPath(config: { agentSelection?: { dbPath?: string } }): string {
  return getDbPath(config.agentSelection?.dbPath);
}

/** List of task identifiers in the database (for export).*/
export function listTaskIds(config: { agentSelection?: { dbPath?: string } }): string[] {
  const db = getDb(config);
  const rows = db.prepare(`SELECT task_id FROM tasks ORDER BY task_id`).all() as Array<{ task_id: string }>;
  return rows.map((r) => r.task_id);
}

/** Number of versions per task (for bootstrap).*/
export function getVersionCountForTask(config: { agentSelection?: { dbPath?: string } }, taskId: string): number {
  const db = getDb(config);
  const row = db.prepare(`SELECT COUNT(*) AS c FROM versions WHERE task_id = ?`).get(taskId) as { c: number };
  return row?.c ?? 0;
}

/** The number of active (not dropped) versions of the task.*/
export function getActiveVersionCountForTask(config: { agentSelection?: { dbPath?: string } }, taskId: string): number {
  const db = getDb(config);
  const row = db.prepare(`SELECT COUNT(*) AS c FROM versions WHERE task_id = ? AND dropped_at IS NULL`).get(taskId) as { c: number };
  return row?.c ?? 0;
}

/** The name of the script for the task (for run_agent, script gets from input_schema_json).*/
export function getTaskScriptName(config: { agentSelection?: { dbPath?: string } }, taskId: string): string | null {
  const db = getDb(config);
  const row = db.prepare(`SELECT tool_name, input_schema_json FROM tasks WHERE task_id = ?`).get(taskId) as
    | { tool_name: string; input_schema_json: string }
    | undefined;
  if (!row || row.tool_name !== "run_agent") return null;
  try {
    const schema = JSON.parse(row.input_schema_json) as { script?: string };
    const script = schema?.script;
    return typeof script === "string" && script.trim() ? script.trim() : null;
  } catch {
    return null;
  }
}

/**
 * If the task does not yet have versions, add the first version from the current script to agents/.
 * Call before pickVersionForRun so that the first run_agent(script, args) adds the current agent to the pool.
 */
export function ensureBootstrapVersionFromScript(
  config: { agentSelection?: { dbPath?: string } },
  taskId: string,
  agentsDir: string,
  script: string
): void {
  if (getVersionCountForTask(config, taskId) > 0) return;
  const scriptPath = resolve(agentsDir, script.replace(/\\/g, "/").replace(/^\/+/, ""));
  let code: string;
  try {
    code = readFileSync(scriptPath, "utf-8");
  } catch {
    selectionLog(config as Claw2Config, "bootstrap", {
      taskId,
      script,
      ok: false,
      reason: "script_not_readable",
    });
    return;
  }
  const versionId = insertVersion(config, taskId, code);
  selectionLog(config as Claw2Config, "bootstrap", {
    taskId,
    script,
    versionId,
    ok: true,
    codeChars: code.length,
  });
}

/** Make sure that the task is in the database; create an entry on first appearance.*/
export function ensureTask(
  config: { agentSelection?: { dbPath?: string } },
  taskId: string,
  toolName: string,
  inputSchemaJson: string
): void {
  const db = getDb(config);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO tasks (task_id, tool_name, input_schema_json, created_at) VALUES (?, ?, ?, ?)`
  ).run(taskId, toolName, inputSchemaJson, now);
}

/** Add a new version of the task agent.*/
export function insertVersion(
  config: { agentSelection?: { dbPath?: string } },
  taskId: string,
  code: string
): string {
  const db = getDb(config);
  const id = `v_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO versions (id, task_id, code, created_at, dropped_at) VALUES (?, ?, ?, ?, NULL)`
  ).run(id, taskId, code, now);
  return id;
}

/** Record the result of running the version.*/
export function insertRun(
  config: { agentSelection?: { dbPath?: string } },
  versionId: string,
  durationMs: number,
  success: boolean,
  errorType: string | null = null,
  rating: number | null = null
): number {
  const db = getDb(config);
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO runs (version_id, timestamp, duration_ms, success, error_type, rating) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(versionId, now, durationMs, success ? 1 : 0, errorType, rating);
  return result.lastInsertRowid as number;
}

/** Update user rating for launch (like/dislike from chat).*/
export function updateRunRating(
  config: { agentSelection?: { dbPath?: string } },
  runId: number,
  rating: number
): boolean {
  const db = getDb(config);
  const result = db.prepare("UPDATE runs SET rating = ? WHERE id = ?").run(rating, runId);
  return result.changes > 0;
}

/** Versions of this task that have less than 5 starts and are not dropped.*/
export function getVersionsWithLessThan5Runs(
  config: { agentSelection?: { dbPath?: string; runsPerVersion?: number } },
  taskId: string,
  runsPerVersion: number = 5
): VersionWithRunCount[] {
  const db = getDb(config);
  const rows = db
    .prepare(
      `SELECT v.id, v.task_id, v.code, v.created_at, v.dropped_at,
              COUNT(r.id) AS run_count
       FROM versions v
       LEFT JOIN runs r ON r.version_id = v.id
       WHERE v.task_id = ? AND v.dropped_at IS NULL
       GROUP BY v.id
       HAVING run_count < ?`
    )
    .all(taskId, runsPerVersion) as Array<{
    id: string;
    task_id: string;
    code: string;
    created_at: string;
    dropped_at: string | null;
    run_count: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    code: r.code,
    createdAt: r.created_at,
    droppedAt: r.dropped_at,
    runCount: r.run_count,
  }));
}

/** Data for the context of the encoder model: dropped versions and the winner for the task.*/
export function getContextForTask(
  config: { agentSelection?: { dbPath?: string } },
  taskId: string
): {
  dropped: Array<{ id: string; code: string; createdAt: string; droppedAt: string; medianDurationMs: number | null; hasErrors: boolean }>;
  winner: { id: string; code: string; medianDurationMs: number | null } | null;
} {
  const db = getDb(config);
  const versions = db
    .prepare(
      `SELECT id, code, created_at, dropped_at FROM versions WHERE task_id = ? ORDER BY created_at ASC`
    )
    .all(taskId) as Array<{ id: string; code: string; created_at: string; dropped_at: string | null }>;

  const dropped: Array<{ id: string; code: string; createdAt: string; droppedAt: string; medianDurationMs: number | null; hasErrors: boolean }> = [];
  const activeWith5Runs: Array<{ id: string; code: string; medianDurationMs: number }> = [];

  for (const v of versions) {
    const runs = db
      .prepare(
        `SELECT duration_ms, success FROM runs WHERE version_id = ? ORDER BY timestamp ASC`
      )
      .all(v.id) as Array<{ duration_ms: number; success: number }>;
    const durations = runs.filter((r) => r.success === 1).map((r) => r.duration_ms);
    const medianDurationMs = median(durations);
    const hasErrors = runs.some((r) => r.success === 0);

    if (v.dropped_at) {
      dropped.push({
        id: v.id,
        code: v.code,
        createdAt: v.created_at,
        droppedAt: v.dropped_at,
        medianDurationMs: medianDurationMs ?? null,
        hasErrors,
      });
    } else if (runs.length >= 5 && !hasErrors && medianDurationMs != null) {
      activeWith5Runs.push({ id: v.id, code: v.code, medianDurationMs });
    }
  }

  const winner =
    activeWith5Runs.length === 0
      ? null
      : activeWith5Runs.reduce((best, cur) =>
          cur.medianDurationMs < best.medianDurationMs ? cur : best
        );
  const winnerResult =
    winner == null
      ? null
      : { id: winner.id, code: winner.code, medianDurationMs: winner.medianDurationMs as number };

  return { dropped, winner: winnerResult };
}

function median(arr: number[]): number | undefined {
  if (arr.length === 0) return undefined;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid];
}

/** Set dropped_at for versions (after selection).*/
export function setVersionsDropped(
  config: { agentSelection?: { dbPath?: string } },
  versionIds: string[]
): void {
  if (versionIds.length === 0) return;
  const db = getDb(config);
  const now = new Date().toISOString();
  const stmt = db.prepare(`UPDATE versions SET dropped_at = ? WHERE id = ?`);
  for (const id of versionIds) {
    stmt.run(now, id);
  }
}

/** Close the connection to the database (for tests or graceful shutdown).*/
export function closeStore(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
