// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it } from "vitest";
import { formatNowContext } from "./now";

// 2026-10-15 14:30 локального времени машины (четверг)
const d = new Date(2026, 9, 15, 14, 30);

describe("formatNowContext (временная привязка модели)", () => {
  it("содержит локальные дату-время в ISO, день недели и человекочитаемую дату", () => {
    const s = formatNowContext(d);
    expect(s).toContain("2026-10-15T14:30");
    expect(s).toContain("четверг");
    expect(s).toContain("октября 2026");
  });

  it("содержит смещение пояса и инструкцию разворачивать относительные фразы самому", () => {
    const s = formatNowContext(d);
    expect(s).toMatch(/UTC[+-]\d{2}:\d{2}/);
    expect(s).toContain("разворачивай");
    expect(s).toContain("не спрашивай");
  });

  it("по умолчанию берёт текущий момент", () => {
    expect(formatNowContext()).toContain(String(new Date().getFullYear()));
  });
});
