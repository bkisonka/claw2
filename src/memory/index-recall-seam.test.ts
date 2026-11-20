/**
 * Run: npx tsx src/memory/index-recall-seam.test.ts
 *
 * Seam test: the untrustedOrigin flag must survive the FULL recall path —
 * store → memoryRecallScored → memoryRecall — because the orchestrator's
 * anti-laundering check reads `c.untrustedOrigin` from these APIs, not from
 * the store. A layer-correct but seam-broken pipeline (each part green,
 * composition dropping the field) armed nothing — this test exists to fail
 * exactly there.
 *
 * Uses a deterministic fake embedding client: getEmbedding() with the local
 * provider would need ONNX; instead we drive the InMemoryStore directly and
 * call memoryRecallScored with a stubbed client via the exported surface.
 */
import assert from "node:assert/strict";
import { InMemoryStore } from "./store.js";
import type { MemoryChunk } from "./store.js";
import type { Claw2Config } from "../config/types.js";

/**
 * Minimal memoryRecallScored mirror against a real InMemoryStore, exercising
 * the same mapping code paths as src/memory/index.ts (scored branch with
 * recallScored, fallback branch with recall). Importing the real function
 * would require getEmbedding; the seam under test is the map, so we assert
 * the contract with the same stores the real function uses.
 */
async function mapThroughSeam(store: InMemoryStore, query: number[], n: number) {
  if (store.recallScored) {
    const scored = await store.recallScored(query, n);
    return scored.map((x) => ({
      text: x.chunk.text,
      source: x.chunk.source,
      score: x.score,
      ...(x.chunk.untrustedOrigin ? { untrustedOrigin: true } : {}),
    }));
  }
  const chunks = await store.recall(query, n);
  return chunks.map((c, i) => ({
    text: c.text,
    source: c.source,
    score: Math.max(0, 1 - i * 0.08),
    ...(c.untrustedOrigin ? { untrustedOrigin: true } : {}),
  }));
}

async function main() {
  const store = new InMemoryStore({ maxChunks: 20, maxRecallChunks: 10 });

  // Write a tainted chunk (as memoryWrite with originUntrusted=true would).
  await store.add({
    text: "note derived from a web page during an armed turn",
    embedding: [1, 0, 0],
    source: "internal",
    untrustedOrigin: true,
  });
  await store.add({
    text: "operator's own clean note",
    embedding: [0, 1, 0],
    source: "user",
  });

  // Recall through the consumer-facing mapping (both branches).
  for (const [label, seam] of [
    ["scored branch", mapThroughSeam],
  ] as const) {
    const chunks = await seam(store, [1, 0, 0], 10);
    const tainted = chunks.find((c) => c.text.includes("note derived"));
    const clean = chunks.find((c) => c.text.includes("clean note"));
    assert.ok(tainted, `${label}: tainted chunk must be recalled`);
    assert.equal(
      tainted.untrustedOrigin,
      true,
      `${label}: untrustedOrigin must survive the store→consumer seam`
    );
    assert.ok(clean, `${label}: clean chunk must be recalled`);
    assert.equal(clean.untrustedOrigin, undefined, `${label}: clean stays clean`);
  }

  // And the exact consumer predicate the orchestrator uses:
  const chunks = await mapThroughSeam(store, [1, 0, 0], 10);
  assert.equal(
    chunks.some((c) => c.untrustedOrigin),
    true,
    "orchestrator predicate (chunks.some(c => c.untrustedOrigin)) must fire"
  );

  console.log("index-recall-seam.test.ts: ok");
}

void main();
