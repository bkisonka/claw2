// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Upgrade-path guard: initDb must converge a database created by the OLDEST
 * supported schema (schema.baseline.sql, currently 0.2.2) to the exact shape
 * of a fresh install from the current schema.sql — table for table, column
 * for column. The 0.2.3 regression (title_manual shipped in schema.sql but
 * not as an ALTER in init.ts, updated installs crashed with "no such
 * column") is the case this test exists to make impossible to repeat:
 * adding a column to schema.sql without the matching ALTER turns this test
 * red with the exact table.column that will not survive an upgrade.
 *
 * The baseline ratchets only when support for old databases is dropped
 * on purpose — replace it with the oldest schema still worth upgrading.
 *
 * Run: npx tsx src/gateway/db/schema-convergence.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { closeDb, initDb } from "./init.js";

const USER = "user-upgrade-test";

const BASELINE = readFileSync(new URL("./schema.baseline.sql", import.meta.url), "utf-8");
const CURRENT = readFileSync(new URL("./schema.sql", import.meta.url), "utf-8");

type ColumnShape = { name: unknown; type: unknown; notnull: unknown; dflt: unknown; pk: unknown };

function shape(db: Database.Database, table: string): ColumnShape[] {
  return (db.pragma(`table_info('${table}')`) as unknown as Array<Record<string, unknown>>).map((c) => ({
    name: c.name,
    type: c.type,
    notnull: c.notnull,
    dflt: c.dflt_value ?? null,
    pk: c.pk,
  }));
}

function tableShapes(sql: string): Map<string, ColumnShape[]> {
  const db = new Database(":memory:");
  db.exec(sql);
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
  const out = new Map<string, ColumnShape[]>();
  for (const t of tables) out.set(t, shape(db, t));
  db.close();
  return out;
}

const expected = tableShapes(CURRENT); // what a fresh install gets
const baseline = tableShapes(BASELINE); // what the oldest supported version left behind

// A table present in the baseline but gone from the current schema would
// linger forever after an upgrade — that needs explicit handling, not silence.
for (const table of baseline.keys()) {
  assert.ok(expected.has(table), `baseline table "${table}" disappeared from schema.sql — handle it explicitly`);
}

const dir = mkdtempSync(join(tmpdir(), "claw2-upgrade-test-"));
const dbPath = join(dir, "chats.db");

const old = new Database(dbPath);
old.exec(BASELINE);
old.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").run(USER, Date.now());
old.prepare("INSERT INTO chats (id, user_id, title, updated_at, created_at) VALUES (?, ?, ?, ?, ?)").run(
  "chat-old",
  USER,
  "Old chat",
  Date.now(),
  Date.now()
);
old.close();

// The upgrade under test.
initDb(dbPath);
closeDb();

const upgraded = new Database(dbPath);
for (const [table, want] of expected) {
  assert.deepEqual(
    shape(upgraded, table),
    want,
    `upgraded "${table}" must match a fresh install — a schema.sql column lacks its ALTER in init.ts`
  );
}
upgraded.close();

// Behavior smoke on the upgraded database (the original 0.2.3 crash site).
const repo = initDb(dbPath);
assert.equal(repo.listChats(USER).length, 1);
assert.equal(repo.listChats(USER)[0]?.title, "Old chat");
assert.equal(repo.renameChatTitle("chat-old", USER, "Renamed by hand"), true);
assert.equal(repo.isTitleManual("chat-old", USER), true);
closeDb();

rmSync(dir, { recursive: true, force: true });
console.log("schema-convergence.test.ts: ok");
