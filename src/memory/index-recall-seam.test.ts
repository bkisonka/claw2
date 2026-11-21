// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Run: npx tsx src/memory/index-recall-seam.test.ts
 *
 * Seam test against the REAL recall API: the untrustedOrigin flag must
 * survive store → memoryRecallScored → memoryRecall, because the
 * orchestrator's anti-laundering check reads `c.untrustedOrigin` from these
 * functions — not from the store. If this mapping ever drops the field
 * again, this test fails and CI goes red.
 *
 * No ONNX needed: getEmbedding(client, …) takes the OpenAI-compatible
 * client, so a stub with embeddings.create covers it; backend "memory"
 * selects the real InMemoryStore. The fallback branch (store without
 * recallScored) is exercised through a wrapper store that hides the method.
 */
import assert from "node:assert/strict";
import {
  memoryRecall,
  memoryRecallScored,
  resetMemoryStore,
  memoryWrite,
  __getMemoryStoreForTest,
  __setMemoryStoreForTest,
} from "./index.js";
import { InMemoryStore } from "./store.js";
import type OpenAI from "openai";
import type { Claw2Config } from "../config/types.js";

const fakeClient = {
  embeddings: {
    create: async () => ({ data: [{ embedding: [1, 0, 0] }] }),
  },
} as unknown as OpenAI;

const config = {
  memory: { enabled: true, backend: "memory" as const, maxChunks: 20, maxRecallChunks: 10 },
} as unknown as Claw2Config;

async function main() {
  // 1. Real API, scored branch (InMemoryStore has recallScored).
  resetMemoryStore();
  // Write through the real memoryWrite so write-side plumbing is exercised
  // too: tainted chunk via originUntrusted=true, then a clean one.
  const w1 = await memoryWrite(fakeClient, config, "note derived from a web page", "internal", undefined, undefined, true);
  const w2 = await memoryWrite(fakeClient, config, "operator's own clean note", "user", undefined, undefined, false);
  assert.equal(w1.ok, true, `tainted write failed: ${w1.ok ? "" : w1.reason}`);
  assert.equal(w2.ok, true, `clean write failed: ${w2.ok ? "" : w2.reason}`);

  const scored = await memoryRecallScored(fakeClient, config, "note derived from a web page");
  const recalled = await memoryRecall(fakeClient, config, "note derived from a web page");
  for (const [label, chunks] of [
    ["memoryRecallScored", scored.chunks],
    ["memoryRecall", recalled.chunks],
  ] as const) {
    const tainted = chunks.find((c) => c.text.includes("note derived"));
    const clean = chunks.find((c) => c.text.includes("clean note"));
    assert.ok(tainted, `${label}: tainted chunk must be recalled`);
    assert.equal(tainted.untrustedOrigin, true, `${label}: flag lost at the store→consumer seam`);
    assert.ok(clean, `${label}: clean chunk must be recalled`);
    assert.equal(clean.untrustedOrigin, undefined, `${label}: clean stays clean`);
    // The exact consumer predicate from the orchestrator:
    assert.equal(
      chunks.some((c) => c.untrustedOrigin),
      true,
      `${label}: orchestrator predicate must fire`
    );
  }

  // 2. Fallback branch through the REAL memoryRecallScored: swap the
  // active default store for a recall-only view (test-injection hook —
  // see __setMemoryStoreForTest in index.ts), so the real function takes
  // the fallback mapping (store.recall + score-by-index).
  resetMemoryStore();
  const w3 = await memoryWrite(fakeClient, config, "fallback tainted note", "internal", undefined, undefined, true);
  assert.equal(w3.ok, true, `fallback write failed: ${w3.ok ? "" : w3.reason}`);
  // Wrap the SAME store instance hiding only recallScored; recall() would
  // still delegate internally, so the wrapper serves both the branch
  // condition and the plain recall the fallback mapping calls.
  const activeInner = __getMemoryStoreForTest();
  assert.ok(activeInner, "test hook must expose the active store");
  __setMemoryStoreForTest({
    add: (c) => activeInner.add(c),
    recall: (q, l, o) => activeInner.recall(q, l, o),
  });
  try {
    const fbScored = await memoryRecallScored(fakeClient, config, "fallback tainted note");
    const fb = fbScored.chunks.find((c) => c.text.includes("fallback tainted note"));
    assert.ok(fb, "fallback branch: tainted chunk must be recalled");
    assert.equal(fb.untrustedOrigin, true, "fallback branch: flag lost at the seam");
    assert.equal(
      fbScored.chunks.some((c) => c.untrustedOrigin),
      true,
      "fallback branch: orchestrator predicate must fire"
    );
    const fbRecall = await memoryRecall(fakeClient, config, "fallback tainted note");
    assert.equal(
      fbRecall.chunks.some((c) => c.untrustedOrigin),
      true,
      "fallback branch through memoryRecall: predicate must fire"
    );
  } finally {
    __setMemoryStoreForTest(null);
  }

  console.log("index-recall-seam.test.ts: ok");
}

void main();
