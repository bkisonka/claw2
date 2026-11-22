// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isGatewayFilesUrl } from "./gatewayUrl";

const BASE = "http://localhost:3000";

describe("isGatewayFilesUrl", () => {
  it("accepts same-origin /files URLs and relative paths", () => {
    assert.equal(isGatewayFilesUrl("/files/output/a.png", BASE), true);
    assert.equal(isGatewayFilesUrl("/files", BASE), true);
    assert.equal(isGatewayFilesUrl(`${BASE}/files/output/a.png`, BASE), true);
    assert.equal(isGatewayFilesUrl(`${BASE}/files/x?download=1`, BASE), true);
  });

  it("refuses foreign origins even when the path contains /files/", () => {
    assert.equal(isGatewayFilesUrl("https://evil.example/files/a.png", BASE), false);
    assert.equal(isGatewayFilesUrl("http://localhost:3000@evil.example/files/a.png", BASE), false);
    assert.equal(isGatewayFilesUrl("https://example.com/files", BASE), false);
  });

  it("refuses same-origin paths outside /files/", () => {
    assert.equal(isGatewayFilesUrl(`${BASE}/api/config`, BASE), false);
    assert.equal(isGatewayFilesUrl("/chat", BASE), false);
    assert.equal(isGatewayFilesUrl(`${BASE}/filesome/x`, BASE), false);
  });

  it("refuses garbage and empty input", () => {
    assert.equal(isGatewayFilesUrl("", BASE), false);
    assert.equal(isGatewayFilesUrl("not a url", BASE), false);
    // No base and no window (node context) — fail closed.
    assert.equal(isGatewayFilesUrl("/files/x", ""), false);
  });
});
