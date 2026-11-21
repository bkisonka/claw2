// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it } from "vitest";
import { getInsightOffer } from "./linker.js";
import type { Claw2Config } from "../config/types.js";

describe("getInsightOffer mode gate", () => {
  it("returns null when mode is off", async () => {
    const config = {
      insights: { enabled: true, mode: "off" as const },
    } as Claw2Config;
    const offer = await getInsightOffer(
      { userId: "u1", sessionId: "s1", userText: "hello" },
      { config, chatRepo: null }
    );
    expect(offer).toBeNull();
  });

  it("returns null without chat repo", async () => {
    const config = {
      insights: { enabled: true, mode: "ask" as const },
    } as Claw2Config;
    const offer = await getInsightOffer(
      { userId: "u1", sessionId: "s1", userText: "RAG fine-tuning" },
      { config, chatRepo: null }
    );
    expect(offer).toBeNull();
  });
});
