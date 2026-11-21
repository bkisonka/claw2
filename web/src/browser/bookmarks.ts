// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/** Local bookmarks for embedded browser. */

export type BrowserBookmark = {
  url: string;
  title: string;
  addedAt: number;
};

const STORAGE_KEY = "claw2.browser.bookmarks";
const MAX = 200;

function canUseStorage(): boolean {
  return typeof localStorage !== "undefined";
}

export function loadBookmarks(): BrowserBookmark[] {
  if (!canUseStorage()) return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((b): b is BrowserBookmark => !!b && typeof (b as BrowserBookmark).url === "string")
      .map((b) => ({
        url: b.url,
        title: typeof b.title === "string" ? b.title : b.url,
        addedAt: typeof b.addedAt === "number" ? b.addedAt : 0,
      }))
      .slice(0, MAX);
  } catch {
    return [];
  }
}

function save(list: BrowserBookmark[]) {
  if (!canUseStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* ignore */
  }
}

export function isBookmarked(url: string, list?: BrowserBookmark[]): boolean {
  const u = url.trim();
  return (list ?? loadBookmarks()).some((b) => b.url === u);
}

export function toggleBookmark(url: string, title = ""): BrowserBookmark[] {
  const u = url.trim();
  if (!u || u === "about:blank") return loadBookmarks();
  const list = loadBookmarks();
  const idx = list.findIndex((b) => b.url === u);
  if (idx >= 0) list.splice(idx, 1);
  else list.unshift({ url: u, title: (title || u).slice(0, 200), addedAt: Date.now() });
  save(list);
  return list;
}
