// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it } from "vitest";
import { extractDialTarget, shouldHintDial } from "./phone-router.js";

describe("phone-router", () => {
  it("detects RU call + number", () => {
    expect(shouldHintDial("Позвони на 89036009030")).toBe(true);
    expect(extractDialTarget("Позвони на 89036009030")).toBe("89036009030");
  });

  it("detects EN dial", () => {
    expect(shouldHintDial("Please dial +7 903 600-90-30 now")).toBe(true);
    expect(extractDialTarget("Please dial +7 903 600-90-30 now")?.endsWith("9036009030")).toBe(
      true,
    );
  });

  it("ignores chatter without call intent", () => {
    expect(shouldHintDial("Мой номер 89036009030, сохрани")).toBe(false);
    expect(shouldHintDial("Как дела?")).toBe(false);
  });
});
