// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * In-memory failure-count limiter for authentication endpoints (login,
 * register). Counts failures per key (ip:login); N failures inside the
 * window lock the key out for a cooldown. Successful authentication clears
 * the counter. Single-process gateway: no shared state is needed.
 */
export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the key may retry (present when blocked). */
  retryAfterSec?: number;
}

export interface LoginRateLimiterOptions {
  /** Failures allowed inside the window before lockout. */
  maxFailures?: number;
  /** Sliding window length in ms (default 5 minutes). */
  windowMs?: number;
  /** Lockout length in ms after exceeding maxFailures (default 15 minutes). */
  lockoutMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

interface Entry {
  failures: number[];
  lockedUntil?: number;
}

export class LoginRateLimiter {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly lockoutMs: number;
  private readonly nowFn: () => number;
  private readonly entries = new Map<string, Entry>();

  constructor(opts: LoginRateLimiterOptions = {}) {
    this.maxFailures = Math.max(1, opts.maxFailures ?? 10);
    this.windowMs = Math.max(1_000, opts.windowMs ?? 5 * 60_000);
    this.lockoutMs = Math.max(1_000, opts.lockoutMs ?? 15 * 60_000);
    this.nowFn = opts.now ?? (() => Date.now());
  }

  /** Check (without recording) whether the key may attempt authentication. */
  attempt(key: string): RateLimitDecision {
    const e = this.entries.get(key);
    if (!e) return { allowed: true };
    const now = this.nowFn();
    if (e.lockedUntil != null && e.lockedUntil > now) {
      return { allowed: false, retryAfterSec: Math.ceil((e.lockedUntil - now) / 1000) };
    }
    return { allowed: true };
  }

  /** Record a failed attempt; may engage the lockout. */
  failure(key: string): RateLimitDecision {
    const now = this.nowFn();
    const e = this.entries.get(key) ?? { failures: [] };
    e.failures = e.failures.filter((t) => now - t < this.windowMs);
    e.failures.push(now);
    let decision: RateLimitDecision = { allowed: true };
    if (e.failures.length >= this.maxFailures) {
      e.lockedUntil = now + this.lockoutMs;
      e.failures = [];
      decision = { allowed: false, retryAfterSec: Math.ceil(this.lockoutMs / 1000) };
    }
    this.entries.set(key, e);
    return decision;
  }

  /** Successful authentication: clear the counter. */
  success(key: string): void {
    this.entries.delete(key);
  }

  /** Drop expired entries (called periodically to bound memory). */
  sweep(): void {
    const now = this.nowFn();
    for (const [key, e] of this.entries) {
      const lockGone = e.lockedUntil == null || e.lockedUntil <= now;
      const failuresGone = e.failures.length === 0 || e.failures.every((t) => now - t >= this.windowMs);
      if (lockGone && failuresGone) this.entries.delete(key);
    }
  }
}
