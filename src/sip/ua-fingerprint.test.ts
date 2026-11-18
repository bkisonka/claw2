import { describe, expect, it } from "vitest";
import type { Claw2Config } from "../config/types.js";
import { sipUaFingerprint } from "./ua-fingerprint.js";

function baseSip(): Claw2Config {
  return {
    llm: { baseURL: "http://x", apiKey: "k", model: "m" },
    sip: {
      enabled: true,
      server: "pbx.example",
      domain: "pbx.example",
      user: "u1",
      password: "p1",
      port: 5060,
      localPort: 5061,
      mediaBackend: "node",
    },
  } as Claw2Config;
}

describe("sipUaFingerprint", () => {
  it("matches for identical SIP identity", () => {
    expect(sipUaFingerprint(baseSip())).toBe(sipUaFingerprint(baseSip()));
  });

  it("changes when server or user changes", () => {
    const a = baseSip();
    const b = baseSip();
    b.sip = { ...b.sip!, server: "other.example" };
    expect(sipUaFingerprint(a)).not.toBe(sipUaFingerprint(b));
  });
});
