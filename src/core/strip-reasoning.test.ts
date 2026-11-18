/**
 * Run: npx tsx src/core/strip-reasoning.test.ts
 */
import assert from "node:assert/strict";
import {
  createReasoningStreamFilter,
  shouldDisableModelThinking,
  stripReasoningTags,
} from "./strip-reasoning.js";

{
  const raw =
    "Пол<mm:think>internal notes about printers</mm:think>ный markdown-отчёт\n\nПе<mm:think>x</mm:think>чати для клиники";
  const cleaned = stripReasoningTags(raw);
  assert.equal(cleaned, "Полный markdown-отчёт\n\nПечати для клиники");
}

{
  const raw = "Hello <think>secret</think> world";
  assert.equal(stripReasoningTags(raw), "Hello world");
}

{
  assert.equal(shouldDisableModelThinking("minimax-m3", undefined), true);
  assert.equal(shouldDisableModelThinking("minimax-m3", false), true);
  assert.equal(shouldDisableModelThinking("minimax-m3", true), false);
  assert.equal(shouldDisableModelThinking("gpt-4o", undefined), false);
  assert.equal(shouldDisableModelThinking("gpt-4o", false), true);
}

{
  const f = createReasoningStreamFilter();
  let out = "";
  out += f.push("Возьм");
  out += f.push("<mm:thi");
  out += f.push("nk>hidden");
  out += f.push("</mm:think>");
  out += f.push("ёшь Node-only");
  out += f.flush();
  assert.equal(out, "Возьмёшь Node-only");
}

console.log("strip-reasoning.test.ts: ok");
