// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

// Run: npx tsx src/tasks/store-reminders.test.ts
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Claw2Config } from "../config/types.js";
import { getTasksDb, reminderAdd, reminderList, reminderMarkSent, remindersGetDue } from "./store.js";

const oldTz = process.env.TZ;
process.env.TZ = "America/New_York";
const dir = mkdtempSync(join(tmpdir(), "claw2-reminders-"));
const dbPath = join(dir, "tasks.db");
const config = { tasks: { dbPath } } as Claw2Config;
try {
  // Populate an old database before the current reader first opens it.
  const old = new Database(dbPath);
  try {
    old.exec(`
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL,
        importance TEXT NOT NULL DEFAULT 'medium', urgency TEXT NOT NULL DEFAULT 'medium',
        done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('once', 'daily', 'every_3_days', 'weekly')),
        run_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO tasks (text) VALUES ('test task');
      INSERT INTO reminders (task_id, type, run_at) VALUES (1, 'daily', '2026-03-07 08:00:00');
    `);
  } finally {
    old.close();
  }

  const add = (params: Omit<Parameters<typeof reminderAdd>[1], "taskId">) => {
    const result = reminderAdd(config, { ...params, taskId: 1 });
    assert.ok(result.ok, JSON.stringify(result));
    return result.id;
  };
  const at = (id: number) => reminderList(config).find((r) => r.id === id)?.runAt;
  const due = (iso: string) => remindersGetDue(config, new Date(iso));

  const local = add({ type: "once", at: "2026-03-07T08:00:00" });
  const offset = add({ type: "once", at: "2026-03-07T15:00:00+02:00" });
  const utc = add({ type: "once", at: "2026-03-07T13:00:00Z" });
  const recurring = add({ type: "daily", firstRun: "2026-03-07T13:00:00.125Z" });
  assert.deepEqual([local, offset, utc].map(at), Array(3).fill("2026-03-07T13:00:00.000Z"));
  assert.equal(at(1), "2026-03-07 08:00:00", "the old row was not rewritten");
  assert.deepEqual(due("2026-03-07T12:59:59.999Z"), []);
  assert.deepEqual(due("2026-03-07T13:00:00.000Z").map((r) => r.id), [1, local, offset, utc]);
  const [legacy, once, , , repeat] = due("2026-03-07T13:00:00.125Z");
  assert.equal(repeat?.id, recurring);
  reminderMarkSent(config, once);
  assert.equal(at(local), undefined, "a successful one-time occurrence is removed");
  reminderMarkSent(config, repeat);
  reminderMarkSent(config, repeat);
  reminderMarkSent(config, legacy);
  reminderMarkSent(config, legacy);
  assert.equal(at(recurring), "2026-03-08T13:00:00.125Z", "new elapsed recurrence advances once in UTC");
  assert.equal(at(1), "2026-03-08 08:00:00", "old recurrence retains its local wall clock");
  assert.ok(!due("2026-03-08T11:59:59.999Z").some((r) => r.id === 1));
  assert.ok(due("2026-03-08T12:00:00.000Z").some((r) => r.id === 1), "legacy scheduling follows DST");

  const before = new Date();
  const automatic = add({ type: "weekly" });
  assert.ok(at(automatic)! >= before.toISOString());
  assert.ok(due(new Date().toISOString()).some((r) => r.id === automatic), "the default first run is immediately due");
  assert.equal(reminderAdd(config, { taskId: 1, type: "once", at: "2026-02-30T10:00:00Z" }).ok, false);
  assert.equal(reminderAdd(config, { taskId: 1, type: "once", at: "not a date" }).ok, false);
} finally {
  getTasksDb(config).close();
  rmSync(dir, { recursive: true, force: true });
  if (oldTz === undefined) delete process.env.TZ;
  else process.env.TZ = oldTz;
}
console.log("store-reminders.test.ts: ok");
