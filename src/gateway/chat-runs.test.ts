// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortChatRun,
  beginChatRun,
  DEFAULT_MAX_CONCURRENT_CHAT_RUNS,
  finishChatRun,
  getChatRun,
  hasActiveChatRun,
  hasStoredSuccessor,
  isChatShuttingDown,
  markChatRunStored,
  publishChatRun,
  resetChatRunsForTest,
  stopChatRunsForShutdown,
  subscribeChatRun,
  toStepEvent,
  waitForChatRun,
  type ChatRun,
} from "./chat-runs.js";

const started: ChatRun[] = [];

function begin(sessionId = "session", userId = "user") {
  const begun = beginChatRun(sessionId, userId);
  if (!begun) throw new Error("run limit reached in the test itself");
  started.push(begun.run);
  return begun;
}

afterEach(() => {
  for (const run of started) if (!run.terminal) finishChatRun(run, {});
  started.length = 0;
  resetChatRunsForTest();
});

describe("chat run registry", () => {
  it("registers a turn and reports it as active until it is finished", () => {
    const { run, previous } = begin();
    expect(previous).toBeNull();
    expect(hasActiveChatRun("session")).toBe(true);
    expect(getChatRun("session")).toBe(run);
    expect(run.userId).toBe("user");
    expect(run.done).toBeInstanceOf(Promise);
    finishChatRun(run, { content: "done" });
    expect(hasActiveChatRun("session")).toBe(false);
    expect(run.terminal).toEqual({ content: "done" });
  });

  it("a second turn for the same session stops the first and hands it back", () => {
    const first = begin().run;
    const second = begin();
    expect(first.controller.signal.aborted).toBe(true);
    expect(first.controller.signal.reason).toBe("Superseded by a newer chat request");
    expect(second.previous).toBe(first);
    // The new turn owns the session slot; finishing the old one must not free it.
    finishChatRun(first, { error: "Chat cancelled" });
    expect(hasActiveChatRun("session")).toBe(true);
    expect(getChatRun("session")).toBe(second.run);
  });

  it(`refuses a ${DEFAULT_MAX_CONCURRENT_CHAT_RUNS + 1}th concurrent session`, () => {
    for (let i = 0; i < DEFAULT_MAX_CONCURRENT_CHAT_RUNS; i++) begin(`session-${i}`);
    expect(beginChatRun("one-too-many", "user")).toBeNull();
    // The same session again is not extra load.
    expect(beginChatRun("session-0", "user")).not.toBeNull();
  });

  it("takes the ceiling from the config: another number, or none", () => {
    started.push(beginChatRun("a", "user", 1)!.run);
    expect(beginChatRun("b", "user", 1)).toBeNull();
    started.push(beginChatRun("c", "user", 0)!.run);
    started.push(beginChatRun("d", "user", 0)!.run);
    expect(getChatRun("d")).toBeDefined();
  });

  it("finishing notifies the subscribers once, resolves done and ignores a second finish", async () => {
    const run = begin().run;
    const listener = vi.fn();
    subscribeChatRun(run, listener);
    let settled = false;
    void run.done.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishChatRun(run, { content: "answer" });
    finishChatRun(run, { content: "ignored" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ terminal: { content: "answer" } });
    await run.done;
    expect(settled).toBe(true);
    expect(run.terminal).toEqual({ content: "answer" });
  });

  it("publish folds content and tool steps into the catch-up state and fans them out", () => {
    const run = begin().run;
    const listener = vi.fn();
    const unsubscribe = subscribeChatRun(run, listener);
    publishChatRun(run, { content: "Hello " });
    publishChatRun(run, { content: "there" });
    publishChatRun(run, { sidebarUpdated: true });
    publishChatRun(run, { toolEvent: { type: "start", seq: 0, iteration: 0, name: "read", args: "{}" } });
    publishChatRun(run, {
      toolEvent: { type: "end", seq: 0, iteration: 0, name: "read", args: "{}", ok: true, durationMs: 7 },
    });
    publishChatRun(run, { toolEvent: { type: "end", seq: 1, iteration: 1, name: "search", args: "{}", ok: false, durationMs: 9 } });

    expect(run.partialContent).toBe("Hello there");
    expect(run.sidebarUpdated).toBe(true);
    expect(run.steps).toEqual([
      { type: "end", seq: 0, iteration: 0, name: "read", args: "{}", ok: true, durationMs: 7 },
      { type: "end", seq: 1, iteration: 1, name: "search", args: "{}", ok: false, durationMs: 9 },
    ]);
    expect(listener).toHaveBeenCalledTimes(6);

    unsubscribe();
    publishChatRun(run, { content: "unheard" });
    expect(listener).toHaveBeenCalledTimes(6);
  });

  it("a broken subscriber breaks neither the turn nor the other subscribers", () => {
    const run = begin().run;
    const healthy = vi.fn();
    subscribeChatRun(run, () => {
      throw new Error("socket gone");
    });
    subscribeChatRun(run, healthy);
    expect(() => publishChatRun(run, { content: "x" })).not.toThrow();
    expect(healthy).toHaveBeenCalledWith({ content: "x" });
    expect(() => finishChatRun(run, { content: "x" })).not.toThrow();
    expect(run.partialContent).toBe("x");
  });

  it("ignores events published after the turn finished", () => {
    const run = begin().run;
    finishChatRun(run, { content: "x" });
    publishChatRun(run, { content: "late" });
    expect(run.partialContent).toBe("");
  });

  it("abortChatRun asks the turn to stop and does nothing when none is running", () => {
    const run = begin().run;
    expect(abortChatRun("missing")).toBeUndefined();
    expect(abortChatRun("session", "Chat cancelled")).toBe(run);
    expect(run.controller.signal.reason).toBe("Chat cancelled");
    finishChatRun(run, {});
    expect(abortChatRun("session")).toBeUndefined();
  });

  it("waitForChatRun gives up after the timeout and returns at once for a finished turn", async () => {
    const run = begin().run;
    const started = Date.now();
    expect(await waitForChatRun(run, 20)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(Date.now() - started).toBeLessThan(500);
    finishChatRun(run, {});
    await expect(waitForChatRun(run, 20)).resolves.toBe(true);
  });

  it("a superseded turn knows whether the turn that replaced it is stored already", () => {
    const first = begin().run;
    expect(hasStoredSuccessor(first)).toBe(false);
    const second = begin().run;
    markChatRunStored(second);
    expect(hasStoredSuccessor(first)).toBe(true);
    // Through a chain: the third turn counts for the first one as well.
    const third = begin().run;
    second.stored = false;
    markChatRunStored(third);
    expect(hasStoredSuccessor(first)).toBe(true);
    expect(hasStoredSuccessor(third)).toBe(false);
  });

  it("keeps the page-text requests of the turn and the page opened while nobody listened", () => {
    const run = begin().run;
    publishChatRun(run, { openBrowserUrl: "https://a.test/" });
    publishChatRun(run, { readBrowserPage: { requestId: "read-1" } });
    publishChatRun(run, { headlessPageText: { requestId: "headless-1", url: "https://b.test/" } });
    publishChatRun(run, { openBrowserUrl: "https://c.test/" });
    // No client was there: the page they missed is the last one opened.
    expect(run.missedOpenUrl).toBe("https://c.test/");
    subscribeChatRun(run, () => {});
    publishChatRun(run, { openBrowserUrl: "https://d.test/" });
    // A page a client saw is not repeated to the next one.
    expect(run.missedOpenUrl).toBe("https://c.test/");
    expect(run.pageRequests).toEqual([
      { requestId: "read-1" },
      { requestId: "headless-1", url: "https://b.test/" },
    ]);
  });

  it("shutdown stops every turn, a superseded one too, refuses new ones and names what did not settle", async () => {
    const first = begin().run;
    const second = begin().run;
    const stubborn = begin("other-session").run;
    const stopping = stopChatRunsForShutdown("Gateway is shutting down", 50);
    // The first was aborted when it was superseded; a signal keeps its first reason.
    expect(first.controller.signal.reason).toBe("Superseded by a newer chat request");
    expect(second.controller.signal.reason).toBe("Gateway is shutting down");
    expect(stubborn.controller.signal.reason).toBe("Gateway is shutting down");
    expect(isChatShuttingDown()).toBe(true);
    expect(beginChatRun("later", "user")).toBeNull();

    finishChatRun(first, {});
    finishChatRun(second, {});
    expect(await stopping).toEqual([stubborn]);
  });

  it("toStepEvent keeps the result text on the server and shortens the arguments", () => {
    const step = toStepEvent({
      type: "end",
      seq: 1,
      iteration: 2,
      name: "read",
      args: JSON.stringify({ path: "a.txt".repeat(60) }),
      result: "SECRET-RESULT-TEXT",
      ok: true,
      durationMs: 3,
      untrusted: false,
      clipped: true,
    });
    expect(step).toMatchObject({ type: "end", seq: 1, iteration: 2, name: "read", ok: true, durationMs: 3, clipped: true });
    expect(JSON.stringify(step)).not.toContain("SECRET-RESULT-TEXT");
    expect(step.args.length).toBeLessThanOrEqual(200);
    expect(toStepEvent({ type: "start", seq: 0, iteration: 0, name: "read", args: "{}" })).toEqual({
      type: "start",
      seq: 0,
      iteration: 0,
      name: "read",
      args: "{}",
    });
  });
});
