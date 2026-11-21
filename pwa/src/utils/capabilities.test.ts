// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it } from "vitest";
import { STANDARD_CAPS, parseNotes, serializeNotes, toggleToken, renameToken } from "./capabilities";

describe("parseNotes", () => {
  it("splits, trims and drops empties", () => {
    expect(parseNotes("код, быстрая ,  ,творческие тексты")).toEqual([
      "код",
      "быстрая",
      "творческие тексты",
    ]);
  });

  it("dedupes case-insensitively keeping the first casing", () => {
    expect(parseNotes("Код, код, КОД")).toEqual(["Код"]);
  });

  it("tolerates empty input", () => {
    expect(parseNotes("")).toEqual([]);
    expect(parseNotes(undefined as unknown as string)).toEqual([]);
  });
});

describe("serializeNotes / toggleToken / renameToken", () => {
  it("roundtrips tokens", () => {
    const tokens = toggleToken(parseNotes("код"), "быстрая");
    expect(serializeNotes(tokens)).toBe("код, быстрая");
  });

  it("toggles by case-insensitive match but keeps stored casing", () => {
    const tokens = ["Код"];
    expect(toggleToken(tokens, "код")).toEqual([]);
    expect(toggleToken([], "Код")).toEqual(["Код"]);
  });

  it("renames a token in place", () => {
    expect(renameToken(["код", "быстрая"], "БЫСТРАЯ", "очень быстрая")).toEqual([
      "код",
      "очень быстрая",
    ]);
  });

  it("exposes a standard set for the checklist", () => {
    expect(STANDARD_CAPS.length).toBeGreaterThanOrEqual(5);
    expect(STANDARD_CAPS).toContain("код");
  });
});
