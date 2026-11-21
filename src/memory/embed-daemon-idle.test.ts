// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMBED_IDLE_MS,
  resolveEmbedIdleMs,
  resolveIdleCheckIntervalMs,
  shouldIdleExit,
} from "./embed-daemon-idle.js";

describe("embed-daemon idle policy", () => {
  it("defaults to 60 minutes", () => {
    expect(resolveEmbedIdleMs(undefined)).toBe(DEFAULT_EMBED_IDLE_MS);
    expect(resolveEmbedIdleMs("")).toBe(DEFAULT_EMBED_IDLE_MS);
    expect(resolveEmbedIdleMs("nope")).toBe(DEFAULT_EMBED_IDLE_MS);
    expect(resolveEmbedIdleMs("500")).toBe(DEFAULT_EMBED_IDLE_MS);
  });

  it("accepts explicit idle ms", () => {
    expect(resolveEmbedIdleMs("60000")).toBe(60_000);
  });

  it("exits only after idle window", () => {
    const start = 1_000_000;
    expect(shouldIdleExit(start, start + 59 * 60_000, DEFAULT_EMBED_IDLE_MS)).toBe(false);
    expect(shouldIdleExit(start, start + DEFAULT_EMBED_IDLE_MS, DEFAULT_EMBED_IDLE_MS)).toBe(true);
  });

  it("keeps check interval bounded", () => {
    expect(resolveIdleCheckIntervalMs(DEFAULT_EMBED_IDLE_MS)).toBe(60_000);
    expect(resolveIdleCheckIntervalMs(30_000)).toBe(5_000);
  });
});
