// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Login rate limiter: failure counting, lockout, sweep, success reset.
 *
 * Run: npx tsx src/gateway/auth/rate-limit.test.ts
 */
import assert from "node:assert/strict";
import { LoginRateLimiter } from "./rate-limit.js";

{
  // 10 failures in the window → lockout with Retry-After.
  let now = 1_000_000;
  const rl = new LoginRateLimiter({ maxFailures: 3, lockoutMs: 60_000, now: () => now });
  assert.deepEqual(rl.attempt("a"), { allowed: true });
  rl.failure("a");
  rl.failure("a");
  assert.deepEqual(rl.attempt("a"), { allowed: true });
  const third = rl.failure("a");
  assert.equal(third.allowed, false);
  assert.equal(third.retryAfterSec, 60);
  now += 30_000;
  assert.equal(rl.attempt("a").allowed, false, "locked within cooldown");
  now += 61_000;
  assert.deepEqual(rl.attempt("a"), { allowed: true }, "lockout expired");
}

{
  // Success clears the counter; failures outside the window expire.
  let now = 0;
  const rl = new LoginRateLimiter({ maxFailures: 2, windowMs: 10_000, lockoutMs: 60_000, now: () => now });
  rl.failure("b");
  rl.success("b");
  assert.deepEqual(rl.attempt("b"), { allowed: true });
  rl.failure("b");
  now += 11_000;
  assert.deepEqual(rl.attempt("b"), { allowed: true }, "windowed failure expired");
  rl.failure("b");
  const second = rl.failure("b");
  assert.equal(second.allowed, false, "two fresh failures lock");
}

{
  // Keys are independent; sweep drops expired entries.
  let now = 100_000;
  const rl = new LoginRateLimiter({ maxFailures: 1, lockoutMs: 5_000, now: () => now });
  rl.failure("c");
  assert.equal(rl.attempt("c").allowed, false);
  rl.failure("d");
  assert.equal(rl.attempt("d").allowed, false);
  now += 6_000;
  rl.sweep();
  assert.deepEqual(rl.attempt("c"), { allowed: true });
  assert.deepEqual(rl.attempt("d"), { allowed: true });
}

console.log("rate-limit.test.ts: ok");
