// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

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
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeMemorySqlite, openMemorySqlite, resolveMemorySqlitePath, resolveSqliteVecPath } from "./sqlite-db.js";
import type { Claw2Config } from "../config/types.js";

const require = createRequire(import.meta.url);

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

  // 6. CLAW2_SQLITE_VEC_PATH: the extension installed or built by hand
  //    (FreeBSD — the package has no binary for it) takes the place of the
  //    package's own. On a platform the package knows, its binary stands in
  //    for the hand-built one: only the path is what differs. An installer
  //    on a platform without a binary exports the variable before the tests.
  const fromInstaller = process.env.CLAW2_SQLITE_VEC_PATH;
  if (!fromInstaller) assert.equal(resolveSqliteVecPath(), null, "no explicit path by default");
  const explicit =
    fromInstaller ?? (require("sqlite-vec") as { getLoadablePath?: () => string }).getLoadablePath?.();
  assert.ok(explicit, "an extension file to load explicitly");
  process.env.CLAW2_SQLITE_VEC_PATH = explicit;
  assert.equal(resolveSqliteVecPath(), explicit, "the explicit path is resolved as given");
  closeMemorySqlite();
  const db3 = openMemorySqlite(config);
  const version = (db3.prepare("SELECT vec_version() AS v").get() as { v: string }).v;
  assert.ok(version.length > 0, "the extension from the explicit path answers vec_version()");

  // 7. A wrong explicit path is that error, not a fallback to the package.
  closeMemorySqlite();
  const missing = join(dir, "no-such-vec0.so");
  process.env.CLAW2_SQLITE_VEC_PATH = missing;
  assert.throws(
    () => openMemorySqlite(config),
    (err: unknown) => err instanceof Error && err.message.includes(missing),
    "the load error must name the missing file"
  );
  // Leave the installer's setting for whatever runs next.
  if (fromInstaller) process.env.CLAW2_SQLITE_VEC_PATH = fromInstaller;
  else delete process.env.CLAW2_SQLITE_VEC_PATH;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("sqlite-db.test.ts: ok");
