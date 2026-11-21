// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it } from "vitest";
import {
  consumePendingHssResponseHint,
  setActivationVectorSeed,
  setPendingHssResponseHint,
} from "../claw-cache/index.js";
import { peekActivationVectorSeed } from "../claw-cache/activation-vector-seed.js";
import { releaseSidebarSession, sidebarSet } from "../sidebar/store.js";
import {
  appendToSession,
  getSessionHistory,
  getSessionPromptContext,
  setSessionPromptContext,
} from "./sessions.js";
import { releaseSessionRuntime } from "./session-runtime-cleanup.js";

describe("session runtime cleanup", () => {
  it("releases only RAM state belonging to the deleted session", () => {
    const sessionId = "cleanup-target";
    const otherSessionId = "cleanup-other";
    const seed = { rows: [[1]], contexts: ["seed"], dim: 1, encoder: "test" };

    setPendingHssResponseHint(sessionId, "a", {
      status: "CRITICAL",
      recommendation: "retry",
      entropyDelta: 1,
      coherence: 0.1,
    });
    setPendingHssResponseHint(otherSessionId, "a", {
      status: "CRITICAL",
      recommendation: "keep",
      entropyDelta: 1,
      coherence: 0.1,
    });
    setActivationVectorSeed(sessionId, "a", seed);
    setActivationVectorSeed(otherSessionId, "a", seed);
    appendToSession(sessionId, "user", "remove");
    appendToSession(otherSessionId, "user", "keep");
    setSessionPromptContext(sessionId, "remove", 1);
    setSessionPromptContext(otherSessionId, "keep", 1);
    sidebarSet(sessionId, {
      items: [{ id: "remove", label: "Remove", action: "prompt", value: "remove" }],
    });

    const result = releaseSessionRuntime(sessionId);

    expect(result.pendingHssHints).toBe(1);
    expect(result.activationVectorSeeds).toBe(1);
    expect(result.sidebarState).toBe(true);
    expect(consumePendingHssResponseHint(sessionId, "a")).toBeNull();
    expect(peekActivationVectorSeed(sessionId, "a")).toBeNull();
    expect(getSessionHistory(sessionId)).toEqual([]);
    expect(getSessionPromptContext(sessionId)).toBeNull();
    expect(releaseSidebarSession(sessionId)).toBe(false);

    expect(consumePendingHssResponseHint(otherSessionId, "a")?.recommendation).toBe("keep");
    expect(peekActivationVectorSeed(otherSessionId, "a")).toBe(seed);
    expect(getSessionHistory(otherSessionId)).toHaveLength(1);
    expect(getSessionPromptContext(otherSessionId)?.summary).toBe("keep");
    releaseSessionRuntime(otherSessionId);
  });
});
