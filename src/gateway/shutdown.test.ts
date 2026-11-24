// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it } from "vitest";
import { CONTAINER_KILL_RESERVE_MS, splitShutdownGrace } from "./shutdown.js";

describe("shutdown grace period", () => {
  it("keeps the reserve for the container kills and gives the running turns the rest", () => {
    expect(splitShutdownGrace(8_000)).toEqual({ turnsMs: 8_000 - CONTAINER_KILL_RESERVE_MS, killsMs: CONTAINER_KILL_RESERVE_MS });
    expect(splitShutdownGrace(10_000)).toEqual({ turnsMs: 8_500, killsMs: 1_500 });
  });

  it("splits a grace period too short for the reserve in halves, so that the turns keep a share", () => {
    expect(splitShutdownGrace(2_000)).toEqual({ turnsMs: 1_000, killsMs: 1_000 });
    expect(splitShutdownGrace(CONTAINER_KILL_RESERVE_MS)).toEqual({ turnsMs: 750, killsMs: 750 });
  });

  it("never waits at all for no grace period, or for a number that is not one", () => {
    expect(splitShutdownGrace(0)).toEqual({ turnsMs: 0, killsMs: 0 });
    expect(splitShutdownGrace(-5)).toEqual({ turnsMs: 0, killsMs: 0 });
    expect(splitShutdownGrace(Number.NaN)).toEqual({ turnsMs: 0, killsMs: 0 });
  });

  it("never spends more than the grace period", () => {
    for (const graceMs of [0, 1, 400, 1_499, 3_000, 3_001, 8_000, 60_000]) {
      const { turnsMs, killsMs } = splitShutdownGrace(graceMs);
      expect(turnsMs + killsMs, String(graceMs)).toBe(graceMs);
    }
  });
});
