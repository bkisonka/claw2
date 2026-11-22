// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Fact lifecycle in vector memory: status active/retired, replaces-link,
 * recall filter, retire, prune order, upgrade of an old memory.sqlite
 * (columns status/superseded_by missing), and the recall rendering with
 * date + id. The Wednesday-reminder case: two versions must never surface
 * together — the replaced one is retired mechanically.
 *
 * Run: npx tsx src/memory/fact-lifecycle.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Claw2Config } from "../config/types.js";
import { closeMemorySqlite, embeddingToMatchParam, openMemorySqlite } from "./sqlite-db.js";
import { SqliteVecStore } from "./sqlite-vec-store.js";
import { InMemoryStore } from "./store.js";
import { formatMemoryHit } from "./index.js";

const tempDirs: string[] = [];

function tempConfig(over: Partial<Claw2Config["memory"]> = {}): Claw2Config {
  const dir = mkdtempSync(join(tmpdir(), "claw2-facts-test-"));
  tempDirs.push(dir);
  return {
    memory: {
      enabled: true,
      backend: "sqlite",
      sqlitePath: join(dir, "memory.sqlite"),
      embeddingDim: 4,
      ...over,
    },
  } as Claw2Config;
}

// Deterministic 4-dim embeddings: version A and B point the same way,
// the unrelated fact points elsewhere — similarity is not the point here.
const embA = [1, 0, 0, 0];
const embB = [1, 0.1, 0, 0];

{
  const config = tempConfig();
  const store = new SqliteVecStore(config);

  const v1 = await store.add({ text: "Напоминание: встреча в среду", embedding: embA, source: "user", importance: 0.9 });
  const v2 = await store.add(
    { text: "Напоминание: встреча перенесена на пятницу", embedding: embB, source: "user", importance: 0.9 },
    { replaces: v1 }
  );

  // The replaced version is retired with the supersede link.
  const db = openMemorySqlite(config);
  const oldRow = db.prepare("SELECT status, superseded_by FROM memory_chunks WHERE chunk_id = ?").get(v1) as
    | { status: string; superseded_by: string | null }
    | undefined;
  assert.equal(oldRow?.status, "retired", "replaces retires the old version");
  assert.equal(oldRow?.superseded_by, v2, "supersede link points at the new version");
  closeMemorySqlite();

  // Recall surfaces only the new version.
  const hits = await store.recall(embA, 10);
  assert.equal(hits.length, 1, "only the active version is recalled");
  assert.equal(hits[0]?.text, "Напоминание: встреча перенесена на пятницу");
  assert.equal(hits[0]?.status !== "retired", true);

  // Retire without a replacement removes the fact from recall.
  assert.equal(await store.retire(v2), true);
  const afterRetire = await store.recall(embA, 10);
  assert.equal(afterRetire.length, 0, "retired fact never comes back");
  closeMemorySqlite();
}

{
  // Ownership: another user's chunk_id reads as not found.
  const config = tempConfig();
  const store = new SqliteVecStore(config);
  const alice = await store.add({ text: "Личное Алисы", embedding: embA, source: "user", userId: "alice" });
  await assert.rejects(
    () => store.add({ text: "подмена", embedding: embB, source: "user", userId: "bob" }, { replaces: alice }),
    /record not found/,
    "bob cannot replace alice's fact"
  );
  assert.equal(await store.retire(alice, { userId: "bob" }), false, "bob cannot retire alice's fact");
  assert.equal(await store.retire(alice, { userId: "alice" }), true, "alice retires her own fact");
  closeMemorySqlite();
}

{
  // Prune: retired facts are evicted before active ones.
  const config = tempConfig({ maxChunks: 2, maxRecallChunks: 5 });
  const store = new SqliteVecStore(config);
  const a = await store.add({ text: "один", embedding: embA, source: "user" });
  await store.add({ text: "два (обновление)", embedding: embB, source: "user" }, { replaces: a });
  await store.add({ text: "три", embedding: [0, 1, 0, 0], source: "user" });
  const db = openMemorySqlite(config);
  const remaining = db.prepare("SELECT text FROM memory_chunks ORDER BY created_at ASC").all() as { text: string }[];
  assert.deepEqual(
    remaining.map((r) => r.text),
    ["два (обновление)", "три"],
    "the retired version is trimmed first, active facts survive"
  );
  closeMemorySqlite();
}

{
  // Upgrade: a pre-lifecycle memory.sqlite (no status/superseded_by) gets the
  // columns via ALTER and old records stay active.
  const dir = mkdtempSync(join(tmpdir(), "claw2-facts-upg-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "memory.sqlite");
  const old = new Database(dbPath);
  old.exec(`
    CREATE TABLE memory_chunks (
      id INTEGER PRIMARY KEY,
      chunk_id TEXT UNIQUE NOT NULL,
      text TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      user_id TEXT,
      importance REAL,
      origin_untrusted INTEGER DEFAULT 0
    );
    CREATE TABLE hss_chronicle (
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
    INSERT INTO memory_chunks (id, chunk_id, text, source, created_at)
      VALUES (1, 'mem_old', 'Старый факт до апгрейда', 'user', ${Date.now()});
  `);
  old.close();

  const config = { memory: { enabled: true, backend: "sqlite" as const, sqlitePath: dbPath, embeddingDim: 4 } } as Claw2Config;
  // Run the upgrade (creates memory_vec + the new columns), then give the
  // pre-upgrade record its vector — kNN needs it.
  const upgraded = openMemorySqlite(config);
  upgraded
    .prepare("INSERT INTO memory_vec(rowid, embedding) VALUES (1, ?)")
    .run(embeddingToMatchParam(embA));
  closeMemorySqlite();
  const store = new SqliteVecStore(config);
  const hits = await store.recall(embA, 10);
  assert.equal(hits.length, 1, "the pre-upgrade record survives and stays active");
  assert.equal(hits[0]?.text, "Старый факт до апгрейда");
  closeMemorySqlite();
}

{
  // Rendering: date + id in every hit the model sees.
  const hit = formatMemoryHit(
    { text: "встреча в пятницу", source: "user", id: "mem_123", createdAt: new Date("2026-11-22T10:00:00Z").getTime() },
    1
  );
  assert.equal(hit, "[1] (user) 2026-11-22 · id=mem_123 · встреча в пятницу");
  const plain = formatMemoryHit({ text: "без id", source: "internal" });
  assert.equal(plain, "(internal) unknown-date · без id");
}

{
  // Verification is a system property: touch stamps it, recall renders the
  // demand — not the model's discipline to retype dates.
  const config = tempConfig();
  const store = new SqliteVecStore(config);
  const id = await store.add({ text: "Пароль от wifi", embedding: embA, source: "user", importance: 0.9 });

  const now = Date.now();
  // Fresh fact, never verified: just its date.
  assert.equal(
    formatMemoryHit({ text: "x", source: "user", createdAt: now - 1000 }, 1, now),
    "[1] (user) " + new Date(now - 1000).toISOString().slice(0, 10) + " · x"
  );
  // Old fact, never verified: the system demands a re-check.
  const oldDay = new Date(now - 40 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  assert.equal(
    formatMemoryHit({ text: "x", source: "user", createdAt: now - 40 * 24 * 3600 * 1000 }, 1, now),
    `[1] (user) не проверено с ${oldDay} — перепроверь (memory_touch) · x`
  );
  // Stale verified fact: same demand, dated from the last verification.
  assert.equal(
    formatMemoryHit({ text: "x", source: "user", createdAt: now - 1000, verifiedAt: now - 40 * 24 * 3600 * 1000 }, 1, now),
    `[1] (user) проверено ${oldDay} — УСТАРЕЛО, перепроверь (memory_touch) · x`
  );

  // touch() stamps verified_at with ownership.
  assert.equal(await store.touch(id, { userId: "bob" }), false, "ownership enforced");
  assert.equal(await store.touch(id), true);
  const hits = await store.recall(embA, 10);
  assert.equal(hits.length, 1);
  assert.ok(typeof hits[0]?.verifiedAt === "number" && hits[0]!.verifiedAt! >= now, "verifiedAt surfaced in recall");
  assert.ok(
    formatMemoryHit(hits[0]!, 1, now).startsWith(`[1] (user) проверено ${new Date(now).toISOString().slice(0, 10)}`),
    "verified fact renders its verification date"
  );
  closeMemorySqlite();
}

{
  // InMemoryStore parity: replaces retires, recall filters.
  const store = new InMemoryStore();
  const a = await store.add({ text: "v1", embedding: embA, source: "user" });
  await store.add({ text: "v2", embedding: embB, source: "user" }, { replaces: a });
  const hits = await store.recall(embA, 10);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.text, "v2");
  assert.equal(await store.retire(hits[0]!.id), true);
  assert.equal((await store.recall(embA, 10)).length, 0);
}

for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
console.log("fact-lifecycle.test.ts: ok");
