/**
 * Run: npx tsx src/security/vision-claim.test.ts
 */
import assert from "node:assert/strict";
import { signVisionClaim, verifyVisionClaim, VISION_CLAIM_MAX_AGE_MS } from "./vision-claim.js";

const SECRET = "test-secret-for-hmac-verification-only";

{
  const ts = Date.now();
  const sig = signVisionClaim(SECRET, "user-42", ts);
  const r = verifyVisionClaim(SECRET, { userId: "user-42", ts, sig });
  assert.equal(r.ok, true, JSON.stringify(r));
}

// Wrong secret → rejected.
{
  const ts = Date.now();
  const sig = signVisionClaim("other-secret", "user-42", ts);
  const r = verifyVisionClaim(SECRET, { userId: "user-42", ts, sig });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "bad_sig");
}

// Forged userId with a signature computed for a different id → rejected.
{
  const ts = Date.now();
  const sig = signVisionClaim(SECRET, "user-42", ts);
  const r = verifyVisionClaim(SECRET, { userId: "admin", ts, sig });
  assert.equal(r.ok, false);
}

// Stale claim outside the freshness window → rejected.
{
  const ts = Date.now() - (VISION_CLAIM_MAX_AGE_MS + 5_000);
  const sig = signVisionClaim(SECRET, "user-42", ts);
  const r = verifyVisionClaim(SECRET, { userId: "user-42", ts, sig });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "stale");
}

// Fresh enough at the edge of the window (small skew) → accepted.
{
  const ts = Date.now() - (VISION_CLAIM_MAX_AGE_MS - 2_000);
  const sig = signVisionClaim(SECRET, "user-42", ts);
  const r = verifyVisionClaim(SECRET, { userId: "user-42", ts, sig });
  assert.equal(r.ok, true);
}

// Malformed payloads → rejected without throwing.
{
  for (const bad of [
    null,
    undefined,
    {},
    { userId: "x" },
    { userId: "x", ts: Date.now() },
    { userId: "x", ts: Date.now(), sig: "deadbeef" },
    { userId: "", ts: Date.now(), sig: signVisionClaim(SECRET, "", Date.now()) },
    { userId: "x", ts: "not-a-number", sig: "a".repeat(64) },
  ]) {
    const r = verifyVisionClaim(SECRET, bad as never);
    assert.equal(r.ok, false, `expected reject for ${JSON.stringify(bad)}`);
  }
}

console.log("vision-claim.test.ts: ok");
