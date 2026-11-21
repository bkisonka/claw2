// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/** Persistent visited-URL history for the embedded browser omnibox. */

export type UrlHistoryEntry = {
  url: string;
  title: string;
  visitCount: number;
  lastVisitedAt: number;
};

const STORAGE_KEY = "claw2.browser.urlHistory";
const MAX_ENTRIES = 200;
export const MAX_URL_SUGGESTIONS = 8;

function canUseStorage(): boolean {
  return typeof localStorage !== "undefined";
}

function isRecordableUrl(url: string): boolean {
  const u = url.trim();
  if (!u || u === "about:blank") return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeHistoryUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = "";
    // Drop trailing slash on bare origins for stabler keys, keep path otherwise.
    if (u.pathname === "/") return u.origin + "/";
    return u.href;
  } catch {
    return url.trim();
  }
}

export function loadUrlHistory(): UrlHistoryEntry[] {
  if (!canUseStorage()) return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is UrlHistoryEntry => {
        if (!item || typeof item !== "object") return false;
        const e = item as UrlHistoryEntry;
        return typeof e.url === "string" && isRecordableUrl(e.url);
      })
      .map((e) => ({
        url: e.url,
        title: typeof e.title === "string" ? e.title : "",
        visitCount: typeof e.visitCount === "number" && e.visitCount > 0 ? e.visitCount : 1,
        lastVisitedAt: typeof e.lastVisitedAt === "number" ? e.lastVisitedAt : 0,
      }))
      .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function saveUrlHistory(entries: UrlHistoryEntry[]): void {
  if (!canUseStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    /* quota / private mode */
  }
}

/** Record or bump a visit. Returns the updated list. */
export function recordUrlVisit(url: string, title = ""): UrlHistoryEntry[] {
  if (!isRecordableUrl(url)) return loadUrlHistory();
  const key = normalizeHistoryUrl(url);
  const now = Date.now();
  const list = loadUrlHistory();
  const idx = list.findIndex((e) => normalizeHistoryUrl(e.url) === key);
  if (idx >= 0) {
    const prev = list[idx]!;
    list.splice(idx, 1);
    list.unshift({
      url: key,
      title: (title.trim() || prev.title).slice(0, 200),
      visitCount: prev.visitCount + 1,
      lastVisitedAt: now,
    });
  } else {
    list.unshift({
      url: key,
      title: title.trim().slice(0, 200),
      visitCount: 1,
      lastVisitedAt: now,
    });
  }
  const next = list.slice(0, MAX_ENTRIES);
  saveUrlHistory(next);
  return next;
}

export function removeUrlHistoryEntry(url: string): UrlHistoryEntry[] {
  const key = normalizeHistoryUrl(url);
  const next = loadUrlHistory().filter((e) => normalizeHistoryUrl(e.url) !== key);
  saveUrlHistory(next);
  return next;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function scoreEntry(entry: UrlHistoryEntry, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return entry.lastVisitedAt;
  const url = entry.url.toLowerCase();
  const title = entry.title.toLowerCase();
  const host = hostOf(entry.url).toLowerCase();
  let score = 0;
  if (host.startsWith(q) || host.includes(q)) score += 120;
  if (url.startsWith(q) || url.includes(`://${q}`) || url.includes(`www.${q}`)) score += 100;
  else if (url.includes(q)) score += 60;
  if (title.startsWith(q)) score += 80;
  else if (title.includes(q)) score += 40;
  if (score === 0) return -1;
  // Prefer frequent + recent among matches.
  score += Math.min(40, entry.visitCount * 2);
  const daysAgo = Math.max(0, (Date.now() - entry.lastVisitedAt) / 86_400_000);
  score += Math.max(0, 30 - daysAgo);
  return score;
}

/** Filter history for omnibox suggestions. Empty query → recent visits. */
export function suggestUrlHistory(
  query: string,
  limit = MAX_URL_SUGGESTIONS,
  entries?: UrlHistoryEntry[]
): UrlHistoryEntry[] {
  const list = entries ?? loadUrlHistory();
  const q = query.trim();
  if (!q) {
    return list.slice(0, limit);
  }
  return list
    .map((e) => ({ e, score: scoreEntry(e, q) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || b.e.lastVisitedAt - a.e.lastVisitedAt)
    .slice(0, limit)
    .map((x) => x.e);
}

export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" && !u.search ? "" : `${u.pathname}${u.search}`;
    return `${u.host}${path}`;
  } catch {
    return url;
  }
}
