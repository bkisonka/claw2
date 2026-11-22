// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import assert from "node:assert/strict";
import { it } from "node:test";
import { createFileGrantCache, type FileGrant } from "./fileGrantCache";

it("ignores an old grant response after a session reset", async () => {
  const requests: ((grant: FileGrant) => void)[] = [];
  const cache = createFileGrantCache(() => new Promise((resolve) => { requests.push(resolve); }));
  const path = "/files/output/image.png";
  const old = cache.get(path);
  await Promise.resolve();
  cache.clear();
  const current = cache.get(path);
  await Promise.resolve();
  const exp = Date.now() + 60_000;
  requests[0]({ k: "old", exp });
  assert.equal(await old, null);
  assert.equal(cache.peek(path), null);
  assert.equal(cache.get(path), current);
  requests[1]({ k: "current", exp });
  assert.deepEqual(await current, { k: "current", exp });
  assert.equal(cache.peek("/files/output/other.png"), null);
});
