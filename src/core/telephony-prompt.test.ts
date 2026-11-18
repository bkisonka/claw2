import { describe, expect, it } from "vitest";
import { buildTelephonyContextBlock, getTelephonyConversationPrompt } from "./telephony-prompt.js";

describe("telephony-prompt", () => {
  it("loads conversation rules (file or fallback)", () => {
    const text = getTelephonyConversationPrompt();
    expect(text.toLowerCase()).toMatch(/hang ?up|трубк|заверш/i);
    expect(text.toLowerCase()).toMatch(/listen|say|вежлив|polite|pleasant|приятн/i);
    expect(text).not.toMatch(/say → listen → hangup/);
  });

  it("wraps a context block", () => {
    const block = buildTelephonyContextBlock();
    expect(block.startsWith("[Telephony")).toBe(true);
    expect(block.length).toBeGreaterThan(80);
  });
});
