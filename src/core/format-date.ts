// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Dates the model sees must be LOCAL to the deployment (TZ env /
 * /etc/localtime), never UTC: a Moscow midnight fact dated "yesterday" by
 * toISOString reads as a day off. One formatter for vector memory, chronicle
 * and everywhere else dates reach the prompt.
 */

const fmtCache = new Map<string, Intl.DateTimeFormat>();

/** YYYY-MM-DD in the given (or system) timezone. */
export function formatDayLocal(ts: number, timeZone?: string): string {
  if (!Number.isFinite(ts)) return "unknown-date";
  try {
    const key = timeZone ?? "";
    let fmt = fmtCache.get(key);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat("sv-SE", timeZone ? { timeZone } : undefined);
      fmtCache.set(key, fmt);
    }
    return fmt.format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}
