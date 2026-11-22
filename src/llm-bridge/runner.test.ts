// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { afterEach, expect, it, vi } from "vitest";
import type { Claw2Config } from "../config/types.js";
import { runOrchestrator } from "../core/orchestrator.js";
import { bridgeFetchMessages, bridgePostMessage, type ConversationMessage } from "./client.js";
import { resetLlmRoomPollCursor, startLlmBridge } from "./runner.js";

vi.mock("../core/orchestrator.js", () => ({ runOrchestrator: vi.fn() }));
vi.mock("./client.js", () => ({
  resolveLlmBridgeConfig: () => ({
    agentId: "self", conversationId: "room", displayName: "Self", participantLabels: { alice: "Alice" },
  }),
  bridgeEnsureConversation: vi.fn().mockResolvedValue({ ok: true }),
  bridgeFetchMessages: vi.fn(),
  bridgePostMessage: vi.fn().mockResolvedValue({ ok: true }),
}));

const config = { llmBridge: { autoReply: true, autoReplyMode: "all" } } as Claw2Config;
function event(id: string, authorId: string, text: string, authorKind: ConversationMessage["authorKind"] = "human"): ConversationMessage {
  // A timestamp tie does not decide where the feed must be cut.
  return { id, authorId, text, authorKind, conversationId: "room", createdAt: 42 };
}

afterEach(() => {
  vi.useRealTimers();
  resetLlmRoomPollCursor();
  vi.clearAllMocks();
});

it("anchors each reply in a polled batch to the matching event ID and author", async () => {
  vi.useFakeTimers();
  const assistant = event("a", "self", "previous answer", "llm");
  const first = event("b", "alice", "first question");
  const second = event("c", "bob", "second question");
  const later = event("d", "charlie", "arrived after poll");
  vi.mocked(bridgeFetchMessages)
    .mockResolvedValueOnce({ ok: true, messages: [first, second] })
    .mockResolvedValue({ ok: true, messages: [assistant, first, second, later] });
  vi.mocked(runOrchestrator).mockResolvedValue({ content: "reply" });

  startLlmBridge(config);
  await vi.advanceTimersByTimeAsync(0);

  const turns = vi.mocked(runOrchestrator).mock.calls.map(([turn]) => turn);
  expect(turns).toHaveLength(2);
  expect(turns[0]).toMatchObject({
    recognizedUser: "llm-room:alice",
    userMessage: expect.stringContaining("[Alice]: <<<EXT>>>\nSource: llm-room-user\nSender: alice\n---\nfirst question"),
    sessionHistory: [{ role: "assistant", content: "previous answer" }],
  });
  expect(turns[1]).toMatchObject({
    recognizedUser: "llm-room:bob",
    userMessage: expect.stringContaining("second question"),
    sessionHistory: [
      { role: "assistant", content: "previous answer" },
      { role: "user", content: expect.stringContaining("first question") },
    ],
  });
  expect(JSON.stringify(turns)).not.toContain(later.text);
  expect(bridgePostMessage).toHaveBeenCalledTimes(2);
});

it("uses the polled event without guessing history when its ID is absent from the window", async () => {
  vi.useFakeTimers();
  const anchor = event("old", "alice", "older question");
  vi.mocked(bridgeFetchMessages)
    .mockResolvedValueOnce({ ok: true, messages: [anchor] })
    .mockResolvedValue({ ok: true, messages: [event("new", "bob", "unrelated message")] });
  vi.mocked(runOrchestrator).mockResolvedValue({ content: "reply" });

  startLlmBridge(config);
  await vi.advanceTimersByTimeAsync(0);

  expect(runOrchestrator).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    recognizedUser: "llm-room:alice",
    userMessage: expect.stringContaining(anchor.text),
    sessionHistory: [],
  }));
});
