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
const PATH = "output/file.png";
const NOW = 1_800_000_000_000;

{
  const k = signFilesToken(SECRET, USER, NOW + FILES_TOKEN_TTL_MS, PATH);
  assert.deepEqual(verifyFilesToken(SECRET, k, PATH, NOW), { userId: USER });
  assert.equal(verifyFilesToken(SECRET, k, "output/another.png", NOW), null);
  assert.equal(verifyFilesToken(SECRET, k, PATH, NOW + FILES_TOKEN_TTL_MS), null);
}

{
  // Expired token refused.
  const k = signFilesToken(SECRET, USER, NOW - 1, PATH);
  assert.equal(verifyFilesToken(SECRET, k, PATH, NOW), null);
  // Beyond-TTL expiry refused even when signed (forgery window bound).
  const far = signFilesToken(SECRET, USER, NOW + FILES_TOKEN_TTL_MS * 10, PATH);
  assert.equal(verifyFilesToken(SECRET, far, PATH, NOW), null);
}

{
  // Tampering with any part refused.
  const k = signFilesToken(SECRET, USER, NOW + FILES_TOKEN_TTL_MS, PATH);
  const [u, e, s] = k.split(".");
  assert.equal(verifyFilesToken(SECRET, `${u + "x"}.${e}.${s}`, PATH, NOW), null);
  assert.equal(verifyFilesToken(SECRET, `${u}.${e}.${s.slice(0, -1)}`, PATH, NOW), null);
  assert.equal(verifyFilesToken(SECRET, `${u}.${Number(e) + 1}.${s}`, PATH, NOW), null);
  // Wrong secret produces a different signature.
  assert.equal(verifyFilesToken("other-secret", k, PATH, NOW), null);
  // Garbage inputs refused.
  assert.equal(verifyFilesToken(SECRET, "", PATH, NOW), null);
  assert.equal(verifyFilesToken(SECRET, "no-dots", PATH, NOW), null);
  assert.equal(verifyFilesToken(SECRET, "..", PATH, NOW), null);
  assert.equal(verifyFilesToken("", k, PATH, NOW), null);
}

console.log("files-token.test.ts: ok");
