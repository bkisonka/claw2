// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Self-update support: the gateway's own version, the latest published
 * release lookup, and the progress state the host-side updater script
 * (scripts/update.sh) reports while it runs.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cachedVersion: string | null = null;

/** Running gateway version, read once from package.json ("0.0.0" fallback). */
export function gatewayVersion(): string {
  if (cachedVersion) return cachedVersion;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(process.cwd(), "package.json"), join(here, "../../package.json")]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as { version?: string };
      if (typeof pkg.version === "string" && pkg.version.trim()) {
        cachedVersion = pkg.version.trim();
        return cachedVersion;
      }
    } catch {
      /* try the next candidate */
    }
  }
  cachedVersion = "0.0.0";
  return cachedVersion;
}

/** "v0.3.1" / "0.3.1-beta" → [0,3,1,"beta"]; null when not version-like. */
export function parseVersion(tag: string): number[] | null {
  const v = tag.trim().replace(/^v/i, "");
  if (!/^\d+(\.\d+)*(-[\w.]+)?$/i.test(v)) return null;
  return v.split("-")[0]!.split(".").map((part) => Number.parseInt(part, 10));
}

/** True when `latest` is strictly newer than `current` (both version-like). */
export function isNewerVersion(current: string, latest: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  if (!a || !b) return false;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return y > x;
  }
  return false;
}

export interface UpdateCheckResult {
  current: string;
  latest: string | null;
  available: boolean;
  releaseUrl: string | null;
  fetchedAt: number;
  error?: string;
}

export const UPDATE_FEED_URL =
  "https://api.github.com/repos/bkisonka/claw2/releases/latest";
const CHECK_TTL_MS = 30 * 60 * 1000;
let checkCache: UpdateCheckResult | null = null;
let checkInFlight: Promise<UpdateCheckResult> | null = null;

async function fetchLatestRelease(feedUrl: string): Promise<{ tag: string | null; url: string | null; error?: string }> {
  try {
    const res = await fetch(feedUrl, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "claw2-update-check" },
      signal: AbortSignal.timeout(6_000),
      redirect: "error",
    });
    if (!res.ok) return { tag: null, url: null, error: `feed HTTP ${res.status}` };
    const data = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
    return {
      tag: typeof data.tag_name === "string" ? data.tag_name : null,
      url: typeof data.html_url === "string" ? data.html_url : null,
    };
  } catch (err) {
    return { tag: null, url: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Latest-release check, cached for 30 minutes; failures degrade to "no data". */
export async function checkForUpdate(feedUrl = UPDATE_FEED_URL): Promise<UpdateCheckResult> {
  const now = Date.now();
  if (checkCache && now - checkCache.fetchedAt < CHECK_TTL_MS) return checkCache;
  if (checkInFlight) return checkInFlight;
  checkInFlight = (async () => {
    const current = gatewayVersion();
    const feed = await fetchLatestRelease(feedUrl);
    const latest = feed.tag && parseVersion(feed.tag) ? feed.tag.replace(/^v/i, "") : null;
    const result: UpdateCheckResult = {
      current,
      latest,
      available: !!(latest && isNewerVersion(current, latest)),
      releaseUrl: feed.url,
      fetchedAt: Date.now(),
      ...(feed.error && !latest ? { error: feed.error } : {}),
    };
    checkCache = result;
    return result;
  })().finally(() => {
    checkInFlight = null;
  });
  return checkInFlight;
}

/** Test hook. */
export function resetUpdateCheckCache(): void {
  checkCache = null;
}

/* ---------- host-side updater (scripts/update.sh) coordination ---------- */

export interface UpdateProgress {
  step: string;
  percent: number;
  message?: string;
  done?: boolean;
  error?: boolean;
  startedAt: number;
  updatedAt: number;
}

let progress: UpdateProgress | null = null;
let requestedAt = 0;
/** Last time the host-side watcher said "I am alive" (idle heartbeats). */
let listenerSeenAt = 0;

export function requestUpdate(now = Date.now()): number {
  requestedAt = now;
  return requestedAt;
}

export function getUpdateRequestAge(now = Date.now()): number {
  return requestedAt ? now - requestedAt : -1;
}

/** Watcher heartbeat + progress reports from the host script. */
export function reportUpdateProgress(
  body: { step?: unknown; percent?: unknown; message?: unknown; done?: unknown; error?: unknown; listener?: unknown },
  now = Date.now()
): UpdateProgress {
  const step = String(body.step ?? "unknown").slice(0, 64);
  const percentRaw = Number(body.percent);
  const percent = Number.isFinite(percentRaw) ? Math.max(0, Math.min(100, Math.round(percentRaw))) : 0;
  const next: UpdateProgress = {
    step,
    percent,
    ...(typeof body.message === "string" ? { message: body.message.slice(0, 300) } : {}),
    ...(body.done === true ? { done: true } : {}),
    ...(body.error === true ? { error: true } : {}),
    startedAt: progress?.startedAt && !progress.done ? progress.startedAt : now,
    updatedAt: now,
  };
  progress = next;
  if (body.listener === true) listenerSeenAt = now;
  return next;
}

/** Current progress + whether an auto-update watcher is connected. */
export function getUpdateStatus(now = Date.now()): {
  progress: UpdateProgress | null;
  autoUpdate: boolean;
  requested: boolean;
} {
  // A finished report older than an hour stops being relevant.
  const live = progress && now - progress.updatedAt < 60 * 60 * 1000 ? progress : null;
  return {
    progress: live,
    autoUpdate: now - listenerSeenAt < 90 * 1000,
    requested: requestedAt > 0 && now - requestedAt < 15 * 60 * 1000,
  };
}

/** Test hook. */
export function resetUpdateState(): void {
  progress = null;
  requestedAt = 0;
  listenerSeenAt = 0;
}
