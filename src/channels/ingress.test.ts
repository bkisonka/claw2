// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Run: npx tsx src/channels/ingress.test.ts
 */
import assert from "node:assert/strict";
import { resolveChannelIngressTrust, channelIngressConfig } from "./ingress.js";
import { InMemoryStore } from "../memory/store.js";
import type { Claw2Config } from "../config/types.js";

// 1. Default: nobody is trusted — channel text is untrusted-origin content.
{
  const r = resolveChannelIngressTrust(undefined, 123);
  assert.equal(r.trusted, false, "missing config → untrusted (hard by default)");
  assert.equal(resolveChannelIngressTrust({}, 123).trusted, false);
  assert.equal(resolveChannelIngressTrust({ trustedUserIds: [] }, 123).trusted, false);
}

// 2. trustedUserIds: listed IDs are trusted operator speech.
{
  const cfg = { trustedUserIds: [42, 777] };
  assert.equal(resolveChannelIngressTrust(cfg, 42).trusted, true);
  assert.equal(resolveChannelIngressTrust(cfg, 777).trusted, true);
  assert.equal(resolveChannelIngressTrust(cfg, 999).trusted, false, "stranger → untrusted");
  assert.equal(resolveChannelIngressTrust(cfg, undefined).trusted, false);
}

// 3. channelIngressConfig lookup.
{
  const config = {
    channels: { telegram: { trustedUserIds: [1] }, vk: {} },
  } as unknown as Claw2Config;
  assert.deepEqual(channelIngressConfig(config, "telegram"), { trustedUserIds: [1] });
  assert.deepEqual(channelIngressConfig(config, "vk"), {});
  assert.equal(channelIngressConfig({} as Claw2Config, "telegram"), undefined);
}

// 4. Memory store contract: untrustedOrigin survives add → recall round-trip
//    (the anti-laundering field must not be dropped by any store backend).
{
  const store = new InMemoryStore({ maxChunks: 10, maxRecallChunks: 5 });
  await store.add({
    text: "summary derived from a web page",
    embedding: [1, 0, 0],
    source: "internal",
    untrustedOrigin: true,
  });
  await store.add({
    text: "operator's own note",
    embedding: [0, 1, 0],
    source: "user",
  });
  const hits = await store.recall([1, 0, 0], 5);
  const tainted = hits.find((c) => c.text.includes("summary derived"));
  const clean = hits.find((c) => c.text.includes("operator's own note"));
  assert.equal(tainted?.untrustedOrigin, true, "tainted chunk must keep the flag");
  assert.equal(clean?.untrustedOrigin, undefined, "clean chunk stays clean");
}

console.log("ingress.test.ts: ok");
