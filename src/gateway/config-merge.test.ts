// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Config save merge: masked secrets survive a round-trip, and the zombie
 * memory.chroma section (defaults served by GET /api_CONFIG live in every UI
 * save payload) is dropped when the backend is not chroma.
 *
 * Run: npx tsx src/gateway/config-merge.test.ts
 */
import assert from "node:assert/strict";
import { mergeConfigKeepingSecrets } from "./server.js";

{
  // Zombie chroma: UI round-trips the default section into a sqlite config.
  const merged = mergeConfigKeepingSecrets(
    { memory: { enabled: true, backend: "sqlite", chroma: { url: "http://localhost:8000", collectionName: "claw2_memory" } } },
    { memory: { enabled: true, backend: "sqlite", maxChunks: 500, chroma: { url: "http://localhost:8000", collectionName: "claw2_memory" } } }
  );
  const mem = merged.memory as Record<string, unknown>;
  assert.equal(mem.backend, "sqlite");
  assert.equal("chroma" in mem, false, "chroma section must not persist for a non-chroma backend");

  // A real chroma backend keeps its section.
  const chromaKept = mergeConfigKeepingSecrets(
    {},
    { memory: { enabled: true, backend: "chroma", chroma: { url: "http://127.0.0.1:8000" } } }
  );
  assert.deepEqual((chromaKept.memory as Record<string, unknown>).chroma, { url: "http://127.0.0.1:8000" });

  // No memory section at all — untouched.
  const noMem = mergeConfigKeepingSecrets({}, { llm: { model: "x" } });
  assert.equal("memory" in noMem, false);

  // Masked secrets round-trip from the existing config (MASK = "***").
  const secrets = mergeConfigKeepingSecrets(
    { llm: { apiKey: "real-key" }, gateway: { auth: { apiKey: "gw-key", sessionSecret: "sess" } } },
    { llm: { apiKey: "***" }, gateway: { auth: { apiKey: "***", sessionSecret: "***" } } }
  );
  assert.equal((secrets.llm as Record<string, unknown>).apiKey, "real-key");
  assert.equal(((secrets.gateway as Record<string, unknown>).auth as Record<string, unknown>).apiKey, "gw-key");
}
console.log("config-merge.test.ts: ok");
