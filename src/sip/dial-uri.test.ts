// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it } from "vitest";
import {
  buildOutboundDialTarget,
  ensureUdpTransport,
  normalizeTargetUri,
} from "./dial-uri.js";

describe("sip dial-uri", () => {
  it("forces transport=udp", () => {
    expect(ensureUdpTransport("sip:100@pbx.example")).toBe("sip:100@pbx.example;transport=udp");
    expect(ensureUdpTransport("sip:100@pbx.example;transport=tcp")).toBe(
      "sip:100@pbx.example;transport=udp",
    );
    expect(ensureUdpTransport("sip:100@pbx.example;user=phone")).toBe(
      "sip:100@pbx.example;user=phone;transport=udp",
    );
  });

  it("normalizes bare numbers onto domain", () => {
    expect(normalizeTargetUri("79001234567", "300217.17.rt.ru")).toBe(
      "sip:79001234567@300217.17.rt.ru;transport=udp",
    );
  });

  it("routes request-uri via registrar host:port", () => {
    const built = buildOutboundDialTarget({
      to: "79001234567",
      domain: "300217.17.rt.ru",
      server: "192.168.50.1",
      port: 5060,
    });
    expect(built.toUri).toBe("sip:79001234567@300217.17.rt.ru;transport=udp");
    expect(built.requestUri).toBe("sip:79001234567@192.168.50.1:5060;transport=udp");
  });
});
