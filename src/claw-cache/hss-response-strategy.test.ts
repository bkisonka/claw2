/**
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * Run: npx tsx src/claw-cache/hss-response-strategy.test.ts
 */
import assert from "node:assert/strict";
import { computeChaosScore } from "./hss-chaos.js";
import {
  classifyResponseStrategy,
  isHssRetryCatastrophicShrink,
  shouldHssCriticalRetry,
} from "./hss-response-strategy.js";

{
  assert.equal(isHssRetryCatastrophicShrink(5574, 189), true);
  assert.equal(isHssRetryCatastrophicShrink(5574, 4000), false);
  assert.equal(isHssRetryCatastrophicShrink(100, 90), false);
  assert.equal(isHssRetryCatastrophicShrink(500, 100), true);
}

{
  // A long Russian-English response with a URL/code should not be considered a violation just because of the mixture of languages.
  const long = `${"Это подробный ответ по задаче. ".repeat(40)}See FILE_URL=/files/output/doc.md and function foo() {}`;
  assert.ok(long.length > 600);
  const chaos = computeChaosScore(long);
  assert.ok(chaos < 0.2, `expected chaos < 0.2, got ${chaos}`);
  const cls = classifyResponseStrategy(long);
  assert.equal(cls.responseStrategy, "answer");
  const decision = shouldHssCriticalRetry("CRITICAL", cls.responseStrategy, long);
  assert.equal(decision.retry, false);
}

console.log("hss-response-strategy.test.ts: ok");
