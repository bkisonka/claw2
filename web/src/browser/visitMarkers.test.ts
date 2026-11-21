// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it, beforeEach } from "vitest";
import {
  mergeHistoryWithVisitMarkers,
  persistVisitMarkersFromMessages,
  loadVisitMarkers,
} from "./visitMarkers";

const mem = new Map<string, string>();

beforeEach(() => {
  mem.clear();
  const api = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, v);
    },
    removeItem: (k: string) => {
      mem.delete(k);
    },
    clear: () => mem.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: api,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    },
  });
});

describe("visitMarkers", () => {
  it("persists to localStorage with afterQaCount", () => {
    persistVisitMarkersFromMessages("s1", [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
      { role: "visit_marker", content: "Habr", at: "2026-07-30T10:00:00.000Z" },
      { role: "user", content: "next" },
    ]);
    expect(loadVisitMarkers("s1")).toEqual([
      { at: "2026-07-30T10:00:00.000Z", content: "Habr", afterQaCount: 2 },
    ]);
  });

  it("merges markers back after restart (no local transcript)", () => {
    persistVisitMarkersFromMessages("s1", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "visit_marker", content: "Site", at: "t1" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ]);
    const server = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ];
    const merged = mergeHistoryWithVisitMarkers("s1", server, []);
    expect(merged.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "visit_marker",
      "user",
      "assistant",
    ]);
    expect(merged[2]).toMatchObject({ role: "visit_marker", content: "Site", at: "t1" });
  });

  it("merges markers back after server history drop with local structure", () => {
    const local = [
      { role: "user", content: "a" },
      { role: "visit_marker", content: "t1", at: "t1" },
      { role: "assistant", content: "b" },
    ];
    persistVisitMarkersFromMessages("s1", local);
    const server = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ];
    const merged = mergeHistoryWithVisitMarkers("s1", server, local);
    expect(merged.map((m) => m.role)).toEqual(["user", "visit_marker", "assistant"]);
  });
});
