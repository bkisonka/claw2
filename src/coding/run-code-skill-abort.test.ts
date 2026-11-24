// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it, vi } from "vitest";
import type { Claw2Config } from "../config/types.js";
import { runCodeSkill } from "./run-code-skill.js";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("../core/llm.js", async (original) => ({
  ...(await original<typeof import("../core/llm.js")>()),
  createClient: () => ({ chat: { completions: { create } } }),
}));

const config = { llm: { provider: "openai", model: "test-model" }, coding: { maxSubagents: 1 } } as Claw2Config;

describe("code_skill cancellation", () => {
  it("does not start sub-agents for an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort("Chat cancelled");
    await expect(runCodeSkill(config, { script: "x.js", task: "do it" }, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("passes the signal to the sub-agent model call and surfaces the abort", async () => {
    create.mockImplementation((_params, options: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort("Chat cancelled"), 50);

    await expect(runCodeSkill(config, { script: "x.js", task: "do it" }, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(create.mock.calls[0]![1]).toEqual({ signal: controller.signal });
  });

  it("calls the model without request options when there is no signal", async () => {
    create.mockResolvedValue({ choices: [{ message: { content: "done" } }] });
    const result = await runCodeSkill(config, { script: "x.js", task: "do it" });
    expect(result.ok).toBe(true);
    expect(create.mock.calls[0]![1]).toBeUndefined();
  });
});
