// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it } from "vitest";
import { BoundedIdleStore } from "./bounded-idle-store.js";
import {
  HSS_NODE_STORE_IDLE_TTL_MS,
  HSS_NODE_STORE_MAX_ENTRIES,
} from "./hss-stabilizer.js";

describe("bounded HSS node store policy", () => {
  it("uses the required HSS bounds", () => {
    expect(HSS_NODE_STORE_MAX_ENTRIES).toBe(64);
    expect(HSS_NODE_STORE_IDLE_TTL_MS).toBe(2 * 60 * 60 * 1000);
  });

  it("tracks access and evicts the least recently accessed entry", () => {
    let now = 0;
    const store = new BoundedIdleStore<string, string>({
      maxEntries: 2,
      idleTtlMs: 100,
      now: () => now,
    });
    store.set("old", "old");
    now = 1;
    store.set("recent", "recent");
    now = 2;
    expect(store.get("old")).toBe("old");
    now = 3;
    store.set("new", "new");

    expect(store.get("recent")).toBeUndefined();
    expect(store.get("old")).toBe("old");
    expect(store.get("new")).toBe("new");
  });

  it("opportunistically prunes entries after their idle TTL", () => {
    let now = 0;
    const store = new BoundedIdleStore<string, string>({
      maxEntries: 2,
      idleTtlMs: 10,
      now: () => now,
    });
    store.set("session:cache", "node");
    now = 9;
    expect(store.get("session:cache")).toBe("node");
    now = 18;
    expect(store.size).toBe(1);
    now = 19;
    expect(store.size).toBe(0);
  });
});
