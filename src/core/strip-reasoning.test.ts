// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Run: npx tsx src/core/strip-reasoning.test.ts
 */
import assert from "node:assert/strict";
import {
  createCommentStreamFilter,
  createEmotionStreamFilter,
  createReasoningStreamFilter,
  extractCommentBlocks,
  extractEmotionTag,
  shouldDisableModelThinking,
  stripCommentTags,
  stripEmotionTags,
  stripReasoningTags,
} from "./strip-reasoning.js";
import { EMOTION_EMOJI, normalizeEmotion } from "./assistant-emotions.js";

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

{
  // Batch: the emotion tag is pulled out and stripped wherever it stands.
  const { content, emotion } = extractEmotionTag("<emotion>happy</emotion>\n\nГотово, файл на месте.");
  assert.equal(emotion, "happy");
  assert.equal(content, "Готово, файл на месте.");
  const partial = extractEmotionTag("Ответ без тега");
  assert.equal(partial.emotion, undefined);
  assert.equal(partial.content, "Ответ без тега");
  assert.equal(stripEmotionTags("<emotion>curious</emotion> Смотрю…"), "Смотрю…");
  // Unterminated trailing tag: still an emotion, never visible text.
  const unterminated = extractEmotionTag("<emotion>thinking");
  assert.equal(unterminated.emotion, "thinking");
  assert.equal(unterminated.content, "");
}

{
  // Streaming: split across arbitrary chunk boundaries, first value wins.
  const values: string[] = [];
  const f = createEmotionStreamFilter((value) => values.push(value));
  let out = "";
  out += f.push("<emo");
  out += f.push("tion>exc");
  out += f.push("ited</emotion> Секунду,\n");
  out += f.push("проверяю…");
  out += f.push("<emotion>happy</emotion>");
  out += f.flush();
  assert.deepEqual(values, ["excited"]);
  assert.equal(out, "Секунду,\nпроверяю…");
}

{
  // Streaming flush: an unterminated tag at the end is still a mood, not text.
  const values: string[] = [];
  const f = createEmotionStreamFilter((value) => values.push(value));
  let out = f.push("Думаю, <emotion>concerned");
  out += f.flush();
  assert.deepEqual(values, ["concerned"]);
  assert.equal(out, "Думаю, ");
}

{
  // Emotion vocabulary: unknown values fold to neutral, emoji map covers all.
  assert.equal(normalizeEmotion("HAPPY"), "happy");
  assert.equal(normalizeEmotion("радость"), "neutral");
  assert.equal(normalizeEmotion(undefined), "neutral");
  assert.equal(normalizeEmotion(""), "neutral");
  assert.equal(EMOTION_EMOJI.neutral, "");
  assert.ok(Object.keys(EMOTION_EMOJI).every((k) => typeof EMOTION_EMOJI[k as keyof typeof EMOTION_EMOJI] === "string"));
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
