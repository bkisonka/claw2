// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it } from "vitest";
import { extractEmotionTag, normalizeEmotion, stripEmotionTags } from "./emotions";

describe("engine emotions (<emotion> tag channel)", () => {
  it("extracts the tag from the head of the answer and trims the leftover newline", () => {
    const { content, emotion } = extractEmotionTag("<emotion>happy</emotion>\nГотово, файл на месте.");
    expect(emotion).toBe("happy");
    expect(content).toBe("Готово, файл на месте.");
  });

  it("treats an unterminated trailing tag as an emotion, not text", () => {
    const { content, emotion } = extractEmotionTag("<emotion>thinking");
    expect(emotion).toBe("thinking");
    expect(content).toBe("");
  });

  it("strips every tag from streamed text, partial tails included", () => {
    expect(stripEmotionTags("<emotion>curious</emotion> Смотрю…")).toBe("Смотрю…");
    expect(stripEmotionTags("Ответ <emotion>happy</emotion> и снова текст")).toBe(
      "Ответ и снова текст"
    );
    expect(stripEmotionTags("Частичный тег <emotion>exc")).toBe("Частичный тег");
  });

  it("folds unknown values to neutral", () => {
    expect(normalizeEmotion("HAPPY")).toBe("happy");
    expect(normalizeEmotion("радость")).toBe("neutral");
    expect(normalizeEmotion(undefined)).toBe("neutral");
  });
});
