// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it } from "vitest";
import { SmedIpcType, packSmedFrame, unpackSmedHeader, SMED_HEADER_SIZE } from "./protocol.js";

describe("SMED dial types", () => {
  it("includes Dial/Outgoing/DialResult", () => {
    expect(SmedIpcType.Dial).toBe(16);
    expect(SmedIpcType.Outgoing).toBe(17);
    expect(SmedIpcType.DialResult).toBe(18);
  });

  it("packs Dial payload", () => {
    const frame = packSmedFrame(SmedIpcType.Dial, Buffer.from("sip:100@pbx:5060;transport=udp"));
    const { type, length } = unpackSmedHeader(frame.subarray(0, SMED_HEADER_SIZE));
    expect(type).toBe(SmedIpcType.Dial);
    expect(length).toBeGreaterThan(0);
    expect(frame.subarray(SMED_HEADER_SIZE).toString("utf8")).toContain("sip:100@");
  });
});
