/**
 * Run: npx tsx src/memory/sqlite-db.test.ts
 *
 * Seam test for the REAL memory SQLite schema: openMemorySqlite() must open
 * a fresh database and apply its full schema without SQL parse errors.
 * Guards the origin_untrusted migration specifically: that block lives
 * outside the db.exec() template — inside it, the JS becomes literal SQL
 * ("near '/': syntax error"), which unit tests over InMemoryStore cannot see.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemorySqlite, resolveMemorySqlitePath } from "./sqlite-db.js";
import type { Claw2Config } from "../config/types.js";

const dir = mkdtempSync(join(tmpdir(), "claw2-memory-sqlite-"));
const config = {
  memory: { enabled: true, backend: "sqlite", embeddingProvider: "local" },
  CLAW2_MEMORY_SQLITE_PATH: join(dir, "memory.sqlite"),
} as unknown as Claw2Config;
// Route the DB through env: resolveMemorySqlitePath honours it before config.
process.env.CLAW2_MEMORY_SQLITE_PATH = join(dir, "memory.sqlite");

try {
  // 1. Fresh DB: schema applies cleanly (this is where the misplaced
  //    migration produced "near '/': syntax error").
  const db = openMemorySqlite(config);
  assert.ok(db, "openMemorySqlite must open a fresh database");

  // 2. The provenance column exists after open.
  const cols = db.prepare("PRAGMA table_info(memory_chunks)").all() as { name: string }[];
  assert.ok(
    cols.some((c) => c.name === "origin_untrusted"),
    `origin_untrusted column must exist, got: ${cols.map((c) => c.name).join(",")}`
  );

  // 3. vec0 tables exist (extension loaded).
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
  ).map((t) => t.name);
  assert.ok(tables.includes("memory_vec"), "memory_vec virtual table must exist");
  assert.ok(tables.includes("chronicle_vec"), "chronicle_vec virtual table must exist");

  // 4. Second open on the SAME path (cachedDb path): idempotent schema.
  const db2 = openMemorySqlite(config);
  assert.equal(db2, db, "same path must reuse the cached connection");

  // 5. Path resolution contract.
  assert.equal(
    resolveMemorySqlitePath(config),
    join(dir, "memory.sqlite"),
    "CLAW2_MEMORY_SQLITE_PATH must win"
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("sqlite-db.test.ts: ok");
