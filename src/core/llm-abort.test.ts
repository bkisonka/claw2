// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import type { Claw2Config } from "../config/types.js";
import { AbortError } from "./abort.js";
import { chat } from "./llm.js";

const config = {
  llm: { provider: "openai", model: "test-model" },
  privacy: { enabled: false },
} as Claw2Config;

describe("LLM cancellation", () => {
  it("passes signal as the second SDK argument and never falls back after abort", async () => {
    const controller = new AbortController();
    const create = vi.fn(async () => {
      controller.abort();
      return {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: "should not emit" } }] };
        },
      };
    });
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;
    const onChunk = vi.fn();

    await expect(
      chat(client, config, [{ role: "user", content: "hello" }], {
        signal: controller.signal,
        onChunk,
      })
    ).rejects.toBeInstanceOf(AbortError);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("passes the signal to a non-streaming request", async () => {
    const controller = new AbortController();
    const create = vi.fn(async () => ({
      choices: [{ message: { content: "ok" } }],
    }));
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;

    const result = await chat(
      client,
      config,
      [{ role: "user", content: "hello" }],
      { signal: controller.signal }
    );

    expect(result.content).toBe("ok");
    expect(create.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
  });
});
