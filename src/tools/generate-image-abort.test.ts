// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Claw2Config } from "../config/types.js";
import { toolGenerateImage } from "./generate-image.js";

let agentsDir: string;

beforeEach(() => {
  // Generated files land in <agentsDir>/output: keep them out of the repository.
  agentsDir = mkdtempSync(join(tmpdir(), "claw2-generate-image-test-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(agentsDir, { force: true, recursive: true });
});

const config = (): Claw2Config => ({ agentsDir, tools: { sdUrl: "http://127.0.0.1:1" } }) as Claw2Config;

describe("generate_image cancellation", () => {
  it("reports a cancelled request as cancelled, not as a timeout", async () => {
    const controller = new AbortController();
    controller.abort("Chat cancelled");
    const fetchSpy = vi.fn((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init.signal;
        const aborted = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) aborted();
        else signal?.addEventListener("abort", aborted, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await toolGenerateImage(config(), "a cat", {}, controller.signal);

    expect(result).toEqual({ ok: false, error: "cancelled" });
    expect(readdirSync(agentsDir)).toEqual([]);
    // The request carries the turn's signal.
    const signal = fetchSpy.mock.calls[0]![1].signal as AbortSignal;
    expect(signal.aborted).toBe(true);
  });

  it("keeps the request running when there is no turn signal", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);
    const result = await toolGenerateImage(config(), "a cat", {});
    expect(result.ok).toBe(true);
    expect(result.imageUrl).toMatch(/^\/files\/output\/generated-\d+\.png$/);
    expect(readdirSync(join(agentsDir, "output"))).toHaveLength(1);
    const signal = fetchSpy.mock.calls[0]![1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
  });
});
