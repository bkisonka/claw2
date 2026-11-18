import { describe, expect, it } from "vitest";
import {
  abortActiveChatRun,
  beginActiveChatRun,
  hasActiveChatRun,
} from "./active-chat-runs.js";

describe("active chat runs", () => {
  it("aborts the previous same-session run and keeps the replacement registered", () => {
    const first = beginActiveChatRun("same");
    const second = beginActiveChatRun("same");

    expect(first.controller.signal.aborted).toBe(true);
    expect(second.controller.signal.aborted).toBe(false);
    first.finish();
    expect(hasActiveChatRun("same")).toBe(true);

    second.finish();
    expect(hasActiveChatRun("same")).toBe(false);
  });

  it("can abort a run before chat deletion", () => {
    const run = beginActiveChatRun("delete-me");
    expect(abortActiveChatRun("delete-me", "Chat deleted")).toBe(true);
    expect(run.controller.signal.aborted).toBe(true);
    expect(run.controller.signal.reason).toBe("Chat deleted");
    run.finish();
  });
});
