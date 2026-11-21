// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it } from "vitest";
import { assertPublicUrl } from "./url-guard.js";

describe("assertPublicUrl", () => {
  it("allows public literal IPs and https URLs", async () => {
    expect((await assertPublicUrl("https://1.1.1.1/")).ok).toBe(true);
    expect((await assertPublicUrl("https://8.8.8.8/x")).ok).toBe(true);
    expect((await assertPublicUrl("https://example.com/")).ok).toBe(true);
  });

  it("blocks literal private and special IPv4", async () => {
    for (const host of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.9", "172.31.255.1",
      "169.254.169.254", "100.64.0.1", "0.1.2.3", "198.18.0.1", "224.0.0.1", "240.0.0.1"]) {
      const r = await assertPublicUrl(`http://${host}/x`);
      expect(r.ok, host).toBe(false);
    }
  });

  it("blocks loopback/IPv6 special forms", async () => {
    expect((await assertPublicUrl("http://[::1]/")).ok).toBe(false);
    expect((await assertPublicUrl("http://[::ffff:127.0.0.1]/")).ok).toBe(false);
    expect((await assertPublicUrl("http://[fd00::1]/")).ok).toBe(false);
    expect((await assertPublicUrl("http://[fe80::1]/")).ok).toBe(false);
  });

  it("blocks internal hostnames and non-http schemes", async () => {
    expect((await assertPublicUrl("http://localhost/")).ok).toBe(false);
    expect((await assertPublicUrl("http://app.localhost/")).ok).toBe(false);
    expect((await assertPublicUrl("http://api.internal/x")).ok).toBe(false);
    expect((await assertPublicUrl("http://nas.local/x")).ok).toBe(false);
    expect((await assertPublicUrl("file:///etc/passwd")).ok).toBe(false);
    expect((await assertPublicUrl("gopher://x")).ok).toBe(false);
  });

  it("rejects garbage", async () => {
    expect((await assertPublicUrl("")).ok).toBe(false);
    expect((await assertPublicUrl("not a url")).ok).toBe(false);
    expect((await assertPublicUrl("http://999.1.1.1/")).ok).toBe(false);
  });

  it("allowPrivate bypasses the guard (documented LAN opt-out)", async () => {
    expect((await assertPublicUrl("http://127.0.0.1:8080/", true)).ok).toBe(true);
    expect((await assertPublicUrl("http://homeassistant.local:8123/", true)).ok).toBe(true);
  });
});
