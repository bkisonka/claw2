// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it } from "vitest";
import {
  getUpdateRequestAge,
  getUpdateStatus,
  isNewerVersion,
  parseVersion,
  reportUpdateProgress,
  requestUpdate,
} from "./update.js";

describe("version comparison", () => {
  it("parses tags with and without the v prefix", () => {
    expect(parseVersion("v0.2.2")).toEqual([0, 2, 2]);
    expect(parseVersion("0.3.1-beta")).toEqual([0, 3, 1]);
    expect(parseVersion("1.0")).toEqual([1, 0]);
    expect(parseVersion("not-a-version")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });

  it("detects strictly newer versions across lengths", () => {
    expect(isNewerVersion("0.2.2", "0.2.3")).toBe(true);
    expect(isNewerVersion("0.2.2", "v0.3.0")).toBe(true);
    expect(isNewerVersion("0.2", "0.2.1")).toBe(true);
    expect(isNewerVersion("0.2.2", "0.2.2")).toBe(false);
    expect(isNewerVersion("0.2.3", "0.2.2")).toBe(false);
    expect(isNewerVersion("0.2.2", "latest")).toBe(false);
  });
});

describe("update coordination state", () => {
  it("request flag ages out and is only set when asked", () => {
    expect(getUpdateRequestAge(1000)).toBe(-1);
    requestUpdate(1000);
    expect(getUpdateRequestAge(2000)).toBe(1000);
    expect(getUpdateStatus(10 * 60 * 1000 + 1000).requested).toBe(true);
    expect(getUpdateStatus(20 * 60 * 1000 + 1000).requested).toBe(false);
  });

  it("tracks watcher heartbeats and clamps progress reports", () => {
    expect(getUpdateStatus().autoUpdate).toBe(false);
    reportUpdateProgress({ listener: true }, 1000);
    expect(getUpdateStatus(2000).autoUpdate).toBe(true);
    expect(getUpdateStatus(120_000).autoUpdate).toBe(false);

    const p = reportUpdateProgress({ step: "build", percent: 250, message: "x".repeat(999), done: true });
    expect(p.percent).toBe(100);
    expect(p.message?.length).toBe(300);
    expect(p.done).toBe(true);
    expect(getUpdateStatus().progress?.step).toBe("build");
  });

  it("keeps startedAt across step reports of one run and resets after done", () => {
    const first = reportUpdateProgress({ step: "start", percent: 5 }, 1000);
    const mid = reportUpdateProgress({ step: "build", percent: 40 }, 2000);
    expect(mid.startedAt).toBe(first.startedAt);
    reportUpdateProgress({ step: "done", percent: 100, done: true }, 3000);
    const next = reportUpdateProgress({ step: "start", percent: 5 }, 5000);
    expect(next.startedAt).toBe(5000);
  });
});
