// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Storage of tasks with importance and urgency: SQLite (.claw2/tasks.db).
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Claw2Config } from "../config/types.js";

const DEFAULT_DB_FILENAME = "tasks.db";

export type TaskLevel = "low" | "medium" | "high";

export interface Task {
  id: number;
  text: string;
  importance: TaskLevel;
  urgency: TaskLevel;
  done: number;
  createdAt: string;
}

function getDbPath(customPath?: string): string {
  if (customPath?.trim()) return resolve(customPath.trim());
  const stateDir = process.env.CLAW2_STATE_DIR?.trim() || ".claw2";
  return resolve(process.cwd(), stateDir, DEFAULT_DB_FILENAME);
}

function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

const MIGRATION = `
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  importance TEXT NOT NULL DEFAULT 'medium',
  urgency TEXT NOT NULL DEFAULT 'medium',
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_importance ON tasks(importance);
CREATE INDEX IF NOT EXISTS idx_tasks_urgency ON tasks(urgency);
CREATE INDEX IF NOT EXISTS idx_tasks_done ON tasks(done);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('once', 'daily', 'every_3_days', 'weekly')),
  run_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reminders_run_at ON reminders(run_at);
`;

let dbInstance: Database.Database | null = null;

function getConfigDbPath(config: Claw2Config): string {
  return getDbPath(config.tasks?.dbPath);
}

export function getTasksDb(config: Claw2Config): Database.Database {
  if (dbInstance) return dbInstance;
  const path = getConfigDbPath(config);
  ensureDir(path);
  dbInstance = new Database(path);
  dbInstance.pragma("foreign_keys = ON");
  dbInstance.exec(MIGRATION);
  try {
    dbInstance.exec("ALTER TABLE tasks ADD COLUMN done INTEGER NOT NULL DEFAULT 0");
  } catch {
    // the column is already there
  }
  return dbInstance;
}

const VALID_LEVELS: TaskLevel[] = ["low", "medium", "high"];

function normalizeLevel(v: unknown): TaskLevel {
  const s = String(v ?? "medium").toLowerCase().trim();
  if (VALID_LEVELS.includes(s as TaskLevel)) return s as TaskLevel;
  if (["low", "short"].includes(s) || s === "1") return "low";
  if (["average", "average", "average"].includes(s) || s === "2") return "medium";
  if (["high", "high", "urgently", "important"].includes(s) || s === "3") return "high";
  return "medium";
}

export function tasksAdd(
  config: Claw2Config,
  params: { text: string; importance?: string; urgency?: string }
): { ok: true; id: number } | { ok: false; error: string } {
  const text = String(params.text ?? "").trim();
  if (!text) return { ok: false, error: "text is required" };
  const importance = normalizeLevel(params.importance);
  const urgency = normalizeLevel(params.urgency);
  try {
    const db = getTasksDb(config);
    const stmt = db.prepare(
      "INSERT INTO tasks (text, importance, urgency, done) VALUES (?, ?, ?, 0)"
    );
    const info = stmt.run(text, importance, urgency);
    return { ok: true, id: info.lastInsertRowid as number };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export type TasksListStatus = "open" | "done" | "all";

export function tasksList(
  config: Claw2Config,
  params: { importance?: string; urgency?: string; status?: TasksListStatus } = {}
): Task[] {
  const db = getTasksDb(config);
  let sql =
    "SELECT id, text, importance, urgency, done, created_at AS createdAt FROM tasks WHERE 1=1";
  const args: (string | number)[] = [];
  const status = params.status ?? "open";
  if (status === "open") {
    sql += " AND done = 0";
  } else if (status === "done") {
    sql += " AND done = 1";
  }
  if (params.importance != null && params.importance !== "") {
    sql += " AND importance = ?";
    args.push(normalizeLevel(params.importance));
  }
  if (params.urgency != null && params.urgency !== "") {
    sql += " AND urgency = ?";
    args.push(normalizeLevel(params.urgency));
  }
  sql += " ORDER BY done ASC, created_at DESC";
  const rows = db.prepare(sql).all(...args) as Task[];
  return rows;
}

export function tasksDone(
  config: Claw2Config,
  params: { id: number }
): { ok: true } | { ok: false; error: string } {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: "id must be a positive integer" };
  try {
    const db = getTasksDb(config);
    const info = db.prepare("UPDATE tasks SET done = 1 WHERE id = ?").run(id);
    if (info.changes === 0) return { ok: false, error: `Task #${id} not found` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export function tasksDelete(
  config: Claw2Config,
  params: { id: number }
): { ok: true } | { ok: false; error: string } {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: "id must be a positive integer" };
  try {
    const db = getTasksDb(config);
    const info = db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    if (info.changes === 0) return { ok: false, error: `Task #${id} not found` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// --- Reminders (separate table: one-time and periodic) ---

export type ReminderType = "once" | "daily" | "every_3_days" | "weekly";

export interface Reminder {
  id: number;
  taskId: number;
  type: ReminderType;
  runAt: string;
  createdAt: string;
}

const REMINDER_TYPES: ReminderType[] = ["once", "daily", "every_3_days", "weekly"];

function normalizeReminderType(v: unknown): ReminderType {
  const s = String(v ?? "").toLowerCase().trim();
  if (REMINDER_TYPES.includes(s as ReminderType)) return s as ReminderType;
  if (s === "day" || s === "every day") return "daily";
  if (s === "3days" || s === "3 days" || s === "every 3 days") return "every_3_days";
  if (s === "week" || s === "week" || s === "every week") return "weekly";
  return "daily";
}

/**
 * Add a reminder for a task. One-time (once) - run_at in ISO format; periodic - firstRun in ISO (or now).
 */
export function reminderAdd(
  config: Claw2Config,
  params: { taskId: number; type: string; at?: string; firstRun?: string }
): { ok: true; id: number } | { ok: false; error: string } {
  const taskId = Number(params.taskId);
  if (!Number.isInteger(taskId) || taskId < 1) return { ok: false, error: "taskId must be a positive integer" };
  const type = normalizeReminderType(params.type);
  const at = (params.at ?? params.firstRun ?? "").trim();
  let runAt: string;
  if (type === "once") {
    if (!at) return { ok: false, error: "For once reminder, at (ISO datetime) is required" };
    runAt = at;
  } else {
    runAt = at ? at.replace("T", " ").slice(0, 19) : new Date().toISOString().slice(0, 19).replace("T", " ");
  }
  if (type === "once" && at) runAt = runAt.replace("T", " ").slice(0, 19);
  try {
    const db = getTasksDb(config);
    const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId) as { id: number } | undefined;
    if (!task) return { ok: false, error: `Task #${taskId} not found` };
    const stmt = db.prepare("INSERT INTO reminders (task_id, type, run_at) VALUES (?, ?, ?)");
    const info = stmt.run(taskId, type, runAt);
    return { ok: true, id: info.lastInsertRowid as number };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** List of reminders for a task (or all).*/
export function reminderList(
  config: Claw2Config,
  params?: { taskId?: number }
): (Reminder & { taskText: string })[] {
  const db = getTasksDb(config);
  let sql = `
    SELECT r.id AS id, r.task_id AS taskId, r.type AS type, r.run_at AS runAt, r.created_at AS createdAt, t.text AS taskText
    FROM reminders r JOIN tasks t ON t.id = r.task_id
  `;
  const args: number[] = [];
  if (params?.taskId != null && Number.isInteger(params.taskId)) {
    sql += " WHERE r.task_id = ?";
    args.push(params.taskId);
  }
  sql += " ORDER BY r.run_at ASC";
  const rows = (args.length ? db.prepare(sql).all(...args) : db.prepare(sql).all()) as (Reminder & { taskText: string })[];
  return rows;
}

/** Reminders that are time to send (run_at <= now).*/
export function remindersGetDue(config: Claw2Config): (Reminder & { taskText: string })[] {
  const db = getTasksDb(config);
  const rows = db
    .prepare(
      `SELECT r.id AS id, r.task_id AS taskId, r.type AS type, r.run_at AS runAt, r.created_at AS createdAt, t.text AS taskText
       FROM reminders r JOIN tasks t ON t.id = r.task_id
       WHERE r.run_at <= datetime('now', 'localtime') ORDER BY r.run_at ASC`
    )
    .all() as (Reminder & { taskText: string })[];
  return rows;
}

/** After sending: for once - delete; for periodic - shift run_at.*/
export function reminderMarkSent(config: Claw2Config, reminderId: number): void {
  const db = getTasksDb(config);
  const row = db.prepare("SELECT id, type, run_at FROM reminders WHERE id = ?").get(reminderId) as { id: number; type: string; run_at: string } | undefined;
  if (!row) return;
  if (row.type === "once") {
    db.prepare("DELETE FROM reminders WHERE id = ?").run(reminderId);
    return;
  }
  const modifier = row.type === "daily" ? "+1 day" : row.type === "every_3_days" ? "+3 days" : "+7 days";
  db.prepare("UPDATE reminders SET run_at = datetime(run_at, ?) WHERE id = ?").run(modifier, reminderId);
}

/** Delete reminder by id.*/
export function reminderDelete(config: Claw2Config, params: { id: number }): { ok: true } | { ok: false; error: string } {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: "id must be a positive integer" };
  try {
    const db = getTasksDb(config);
    const info = db.prepare("DELETE FROM reminders WHERE id = ?").run(id);
    if (info.changes === 0) return { ok: false, error: `Reminder #${id} not found` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
