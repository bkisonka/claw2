// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * /files signed token: issue → verify round-trip, expiry, tamper, wrong
 * secret, garbage input.
 *
 * Run: npx tsx src/gateway/files-token.test.ts
 */
import assert from "node:assert/strict";
import { FILES_TOKEN_TTL_MS, signFilesToken, verifyFilesToken } from "./files-token.js";

const SECRET = "test-secret-0123456789abcdef";
const USER = "user-1";
const NOW = 1_800_000_000_000;

{
  const k = signFilesToken(SECRET, USER, NOW + FILES_TOKEN_TTL_MS);
  assert.deepEqual(verifyFilesToken(SECRET, k, NOW), { userId: USER });
}

{
  // Expired token refused.
  const k = signFilesToken(SECRET, USER, NOW - 1);
  assert.equal(verifyFilesToken(SECRET, k, NOW), null);
  // Beyond-TTL expiry refused even when signed (forgery window bound).
  const far = signFilesToken(SECRET, USER, NOW + FILES_TOKEN_TTL_MS * 10);
  assert.equal(verifyFilesToken(SECRET, far, NOW), null);
}

{
  // Tampering with any part refused.
  const k = signFilesToken(SECRET, USER, NOW + FILES_TOKEN_TTL_MS);
  const [u, e, s] = k.split(".");
  assert.equal(verifyFilesToken(SECRET, `${u + "x"}.${e}.${s}`, NOW), null);
  assert.equal(verifyFilesToken(SECRET, `${u}.${e}.${s.slice(0, -1)}`, NOW), null);
  assert.equal(verifyFilesToken(SECRET, `${u}.${Number(e) + 1}.${s}`, NOW), null);
  // Wrong secret produces a different signature.
  assert.equal(verifyFilesToken("other-secret", k, NOW), null);
  // Garbage inputs refused.
  assert.equal(verifyFilesToken(SECRET, "", NOW), null);
  assert.equal(verifyFilesToken(SECRET, "no-dots", NOW), null);
  assert.equal(verifyFilesToken(SECRET, "..", NOW), null);
  assert.equal(verifyFilesToken("", k, NOW), null);
}

console.log("files-token.test.ts: ok");
