// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * formatDayLocal: model-visible dates follow the deployment timezone —
 * 00:04 Moscow is the 23rd in Moscow and still the 22nd in UTC, and the
 * memory hit must show the Moscow day (the original complaint).
 *
 * Run: npx tsx src/core/format-date.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { formatDayLocal } from "./format-date.js";

describe("formatDayLocal", () => {
  // 2026-11-23 00:04 Europe/Moscow === 2026-11-22 21:04 UTC.
  const moscowMidnight = Date.parse("2026-11-22T21:04:00Z");

  it("renders the local calendar day, not the UTC one", () => {
    assert.equal(formatDayLocal(moscowMidnight, "Europe/Moscow"), "2026-11-23");
    assert.equal(formatDayLocal(moscowMidnight, "UTC"), "2026-11-22");
  });

  it("falls back gracefully for a bad timezone or timestamp", () => {
    assert.equal(formatDayLocal(moscowMidnight, "Not/AZone"), "2026-11-22");
    assert.equal(formatDayLocal(NaN), "unknown-date");
  });
});
