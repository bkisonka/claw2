// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it } from "vitest";
import {
  shouldHintCode,
  looksLikeCode,
} from "../../src/core/code-router";

describe("code-router skill vs chat code", () => {
  it("does not treat bubble-sort requests as skill creation", () => {
    expect(shouldHintCode("напиши код сортировки пузырьком на python")).toBe(false);
    expect(shouldHintCode("write code for bubble sort")).toBe(false);
    expect(shouldHintCode("напиши функцию сортировки")).toBe(false);
  });

  it("detects explicit skill/agent creation", () => {
    expect(shouldHintCode("создай агента для pdf")).toBe(true);
    expect(shouldHintCode("create a skill for charts")).toBe(true);
  });

  it("looksLikeCode detects fenced python", () => {
    const sample = "Вот пузырёк:\n\n```python\ndef bubble(a):\n    n = len(a)\n    for i in range(n):\n        for j in range(0, n - i - 1):\n            if a[j] > a[j + 1]:\n                a[j], a[j + 1] = a[j + 1], a[j]\n    return a\n```\n";
    expect(looksLikeCode(sample)).toBe(true);
  });
});
