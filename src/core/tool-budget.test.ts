// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { clipHeadTail, clipToolResult, compactToolResults, type ToolCallMeta } from "./tool-budget.js";

function toolMessage(id: string, content: string): OpenAI.Chat.ChatCompletionToolMessageParam {
  return { role: "tool", tool_call_id: id, content };
}

describe("clipHeadTail", () => {
  it("returns text inside the limit unchanged", () => {
    expect(clipHeadTail("abc", 10)).toEqual({ text: "abc", clipped: false });
  });

  it("keeps the head and the tail and reports the clip", () => {
    // 5 kept: 4 from the head, 1 from the tail.
    expect(clipHeadTail("0123456789", 5)).toEqual({ text: "01239", clipped: true });
  });
});

describe("clipToolResult", () => {
  it("leaves a result inside the limit alone", () => {
    const content = "x".repeat(1_000);
    expect(clipToolResult(content, 1_000)).toEqual({ content, clipped: false, originalChars: 1_000 });
  });

  it("cuts the middle, stays within the limit and keeps both ends of a wrapped result", () => {
    const content = `${"<open>".padEnd(5_000, "a")}MIDDLE${"b".repeat(5_000)}<close>`;
    const clipped = clipToolResult(content, 2_000);
    expect(clipped.clipped).toBe(true);
    expect(clipped.originalChars).toBe(content.length);
    expect(clipped.content.length).toBeLessThanOrEqual(2_000);
    expect(clipped.content.startsWith("<open>")).toBe(true);
    expect(clipped.content.endsWith("<close>")).toBe(true);
    expect(clipped.content).toContain("tool result clipped");
    expect(clipped.content).toContain("read(path, offset, limit)");
    expect(clipped.content).not.toContain("MIDDLE");
  });
});

describe("compactToolResults", () => {
  const meta = new Map<string, ToolCallMeta>([
    ["a", { name: "read", args: '{"path":"a.txt"}' }],
    ["b", { name: "read", args: '{"path":"b.txt"}' }],
    ["c", { name: "read", args: '{"path":"c.txt"}' }],
  ]);

  /** user, assistant+result a, assistant+result b, assistant+result c */
  function conversation(): OpenAI.Chat.ChatCompletionMessageParam[] {
    const assistant: OpenAI.Chat.ChatCompletionAssistantMessageParam = { role: "assistant", content: null };
    return [
      { role: "user", content: "q" },
      assistant,
      toolMessage("a", "A".repeat(3_000)),
      assistant,
      toolMessage("b", "B".repeat(3_000)),
      assistant,
      toolMessage("c", "C".repeat(3_000)),
    ];
  }

  const toolTotal = (messages: OpenAI.Chat.ChatCompletionMessageParam[]) =>
    messages.reduce((n, m) => (m.role === "tool" ? n + String(m.content).length : n), 0);

  it("does nothing while the tool context is inside the budget", () => {
    const messages = conversation();
    expect(compactToolResults(messages, meta, new Set(), { maxTotalChars: 10_000 })).toBe(0);
    expect(messages[2]!.content).toBe("A".repeat(3_000));
  });

  it("compacts the oldest results first and leaves the current iteration whole", () => {
    const messages = conversation();
    expect(compactToolResults(messages, meta, new Set(["c"]), { maxTotalChars: 5_000 })).toBe(2);
    expect(messages[2]!.content).toMatch(
      /^\[compacted tool result: read \{"path":"a\.txt"\} — [0-9,]+ characters omitted to stay inside the context budget; call the tool again if you need the full output\.\]\nA+$/
    );
    expect(String(messages[4]!.content)).toContain('"path":"b.txt"');
    expect(messages[6]!.content).toBe("C".repeat(3_000));
    // The protected result keeps its 3 000; the two compacted ones are down to a head each.
    expect(toolTotal(messages)).toBeLessThan(6_000);
    expect(String(messages[2]!.content).length).toBeLessThan(1_500);
    expect(String(messages[4]!.content).length).toBeLessThan(1_500);
  });

  it("stops at the protected results even if that leaves the budget exceeded", () => {
    const messages = conversation();
    expect(compactToolResults(messages, meta, new Set(["a", "b", "c"]), { maxTotalChars: 1_000 })).toBe(0);
    expect(messages[2]!.content).toBe("A".repeat(3_000));
  });

  it("never grows a short result and does not compact twice", () => {
    const messages = [toolMessage("short", "S".repeat(100)), toolMessage("big", "B".repeat(4_000))];
    const small = new Map<string, ToolCallMeta>([
      ["short", { name: "tasks_list", args: "{}" }],
      ["big", { name: "read", args: '{"path":"big.txt"}' }],
    ]);
    expect(compactToolResults(messages, small, new Set(), { maxTotalChars: 3_000, headChars: 500 })).toBe(1);
    expect(messages[0]!.content).toBe("S".repeat(100));
    expect(String(messages[1]!.content).startsWith("[compacted tool result")).toBe(true);
    expect(messages[1]!.content.length).toBeLessThan(4_000);
    // Both are now as small as they get: nothing left to compact.
    expect(compactToolResults(messages, small, new Set(), { maxTotalChars: 100, headChars: 500 })).toBe(0);
  });
});
