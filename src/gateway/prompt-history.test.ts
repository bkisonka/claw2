/**
 * Run: npx tsx src/gateway/prompt-history.test.ts
 */
import assert from "node:assert/strict";
import {
  PROMPT_SUMMARY_PREFIX,
  PROMPT_SUMMARY_PREFIX_LEGACY,
  applyPromptContext,
  peelPromptSummary,
  isPromptSummaryStub,
} from "./prompt-history.js";

const full = [
  { role: "user" as const, content: "a" },
  { role: "assistant" as const, content: "b" },
  { role: "user" as const, content: "c" },
];

const withCtx = applyPromptContext(full, { summary: "was about cats", coveredCount: 2 });
assert.equal(withCtx[0]?.role, "user");
assert.ok(withCtx[0]?.content.startsWith(PROMPT_SUMMARY_PREFIX));
assert.ok(isPromptSummaryStub(withCtx[0]));

const peeled = peelPromptSummary(withCtx);
assert.equal(peeled.history.length, 1);
assert.equal(peeled.history[0]?.content, "c");
assert.ok(peeled.summaryBlock?.includes("was about cats"));
assert.ok(peeled.summaryBlock?.startsWith(PROMPT_SUMMARY_PREFIX));

const legacy = peelPromptSummary([
  { role: "assistant", content: `${PROMPT_SUMMARY_PREFIX_LEGACY}old` },
  { role: "user", content: "hi" },
]);
assert.equal(legacy.history[0]?.content, "hi");
assert.ok(legacy.summaryBlock?.includes("old"));

console.log("prompt-history.test.ts: ok");
