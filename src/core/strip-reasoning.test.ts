// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Run: npx tsx src/core/strip-reasoning.test.ts
 */
import assert from "node:assert/strict";
import {
  createCommentStreamFilter,
  createReasoningStreamFilter,
  extractCommentBlocks,
  shouldDisableModelThinking,
  stripCommentTags,
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

{
  const seen: string[] = [];
  const filter = createCommentStreamFilter((text) => seen.push(text));
  let visible = filter.push("Working. <comment>Чит");
  assert.equal(visible, "Working. ");
  visible += filter.push("аю файл — сверяю</comment> Done");
  assert.equal(visible, "Working.  Done");
  assert.deepEqual(seen, ["Читаю файл — сверяю"]);
}

{
  const seen: string[] = [];
  const filter = createCommentStreamFilter((text) => seen.push(text));
  let visible = filter.push("text <comment>partial comment");
  assert.equal(visible, "text ");
  visible += filter.flush();
  assert.equal(visible, "text ");
  assert.deepEqual(seen, ["partial comment"]);
}

{
  const seen: string[] = [];
  const filter = createCommentStreamFilter((text) => seen.push(text));
  let visible = filter.push("a <comments>b</comments> c");
  visible += filter.flush();
  assert.equal(visible, "a <comments>b</comments> c");
  assert.deepEqual(seen, []);
}

{
  const { content, comments } = extractCommentBlocks("A <comment>один</comment> B <comment>два</comment>");
  assert.equal(content, "A B");
  assert.deepEqual(comments, ["один", "два"]);
  const trailing = extractCommentBlocks("Answer <comment>незакрытый");
  assert.equal(trailing.content, "Answer");
  assert.deepEqual(trailing.comments, ["незакрытый"]);
  assert.equal(extractCommentBlocks("plain").comments.length, 0);
}

{
  assert.equal(stripCommentTags("x <comment>статус</comment> y"), "x y");
  assert.equal(stripCommentTags("x <comment>статус"), "x");
}
