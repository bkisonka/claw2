// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Persist visit_marker rows locally — gateway history stores only user/assistant.
 * Uses localStorage so markers survive app restart (sessionStorage did not).
 */

const STORAGE_KEY = "claw2.browser.visitMarkers";

export type VisitMarkerRow = {
  at: string;
  content: string;
  /** How many user/assistant messages precede this marker in the transcript. */
  afterQaCount: number;
};

/** Display label: optional site title + localized datetime. */
export function formatVisitMarkerLabel(
  atOrIso: string,
  locale: string,
  siteTitle?: string | null
): string {
  let time = atOrIso;
  try {
    const d = new Date(atOrIso);
    if (!Number.isNaN(d.getTime())) {
      time = new Intl.DateTimeFormat(locale.startsWith("ru") ? "ru-RU" : "en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(d);
    }
  } catch {
    /* keep */
  }
  const raw = (siteTitle || "").trim();
  // Legacy markers stored ISO in content — ignore as title.
  const title = raw && !/^\d{4}-\d{2}-\d{2}T/.test(raw) ? raw : "";
  return title ? `${title} · ${time}` : time;
}

type Store = Record<string, VisitMarkerRow[]>;

function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function readStore(): Store {
  try {
    const ls = storage();
    let raw = ls?.getItem(STORAGE_KEY) ?? null;
    // One-time migrate from sessionStorage (v1).
    if (!raw) {
      try {
        raw = sessionStorage.getItem(STORAGE_KEY);
        if (raw && ls) {
          ls.setItem(STORAGE_KEY, raw);
          sessionStorage.removeItem(STORAGE_KEY);
        }
      } catch {
        /* ignore */
      }
    }
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Store = {};
    for (const [sid, rows] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(rows)) continue;
      const cleaned: VisitMarkerRow[] = [];
      for (const r of rows) {
        if (!r || typeof r !== "object") continue;
        const at = String((r as VisitMarkerRow).at || (r as { content?: string }).content || "");
        if (!at) continue;
        const afterQaCount = Number((r as VisitMarkerRow).afterQaCount);
        cleaned.push({
          at,
          content: String((r as VisitMarkerRow).content || at),
          afterQaCount: Number.isFinite(afterQaCount) && afterQaCount >= 0 ? afterQaCount : 0,
        });
      }
      if (cleaned.length) out[sid] = cleaned;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    const ls = storage();
    if (!ls) return;
    ls.setItem(STORAGE_KEY, JSON.stringify(store));
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
}

export function loadVisitMarkers(sessionId: string): VisitMarkerRow[] {
  if (!sessionId) return [];
  return readStore()[sessionId] ?? [];
}

/** Replace stored markers for a session from a full transcript. */
export function persistVisitMarkersFromMessages(
  sessionId: string,
  messages: { role: string; content?: string; at?: string }[]
): void {
  if (!sessionId) return;
  const rows: VisitMarkerRow[] = [];
  const seen = new Set<string>();
  let qa = 0;
  for (const m of messages) {
    if (m.role === "visit_marker") {
      const at = String(m.at || m.content || "");
      if (!at || seen.has(at)) continue;
      seen.add(at);
      rows.push({ at, content: String(m.content || at), afterQaCount: qa });
      continue;
    }
    if (m.role === "user" || m.role === "assistant") qa += 1;
  }
  const store = readStore();
  if (rows.length === 0) {
    if (store[sessionId]) {
      delete store[sessionId];
      writeStore(store);
    }
    return;
  }
  store[sessionId] = rows;
  writeStore(store);
}

/** Drop visit markers for a deleted chat. */
export function clearVisitMarkers(sessionId: string): void {
  if (!sessionId) return;
  const store = readStore();
  if (!store[sessionId]) return;
  delete store[sessionId];
  writeStore(store);
}

type Msg = { role: string; content?: string; at?: string };

/**
 * Rebuild transcript: keep server user/assistant order, re-insert visit markers
 * from local transcript and/or localStorage (by `at` dedupe, placed by afterQaCount).
 */
export function mergeHistoryWithVisitMarkers<T extends Msg>(
  sessionId: string,
  server: T[],
  local: T[]
): T[] {
  const stored = loadVisitMarkers(sessionId);
  const markers: VisitMarkerRow[] = [];
  const seen = new Set<string>();

  if (local.some((m) => m.role === "visit_marker")) {
    // Prefer structural order from the live local transcript.
    let qa = 0;
    for (const m of local) {
      if (m.role === "visit_marker") {
        const at = String(m.at || m.content || "");
        if (!at || seen.has(at)) continue;
        seen.add(at);
        markers.push({
          at,
          content: String(m.content || at),
          afterQaCount: qa,
        });
        continue;
      }
      if (m.role === "user" || m.role === "assistant") qa += 1;
    }
  }

  for (const r of stored) {
    const at = String(r.at || r.content || "");
    if (!at || seen.has(at)) continue;
    seen.add(at);
    markers.push({
      at,
      content: String(r.content || at),
      afterQaCount: Number.isFinite(r.afterQaCount) ? r.afterQaCount : 0,
    });
  }

  if (markers.length === 0) return server;

  const serverQA = server.filter((m) => m.role === "user" || m.role === "assistant");
  if (local.some((m) => m.role === "visit_marker")) {
    let si = 0;
    const out: T[] = [];
    for (const m of local) {
      if (m.role === "visit_marker") {
        out.push(m);
        continue;
      }
      if (m.role === "user" || m.role === "assistant") {
        if (si < serverQA.length) out.push(serverQA[si++] as T);
      }
    }
    while (si < serverQA.length) out.push(serverQA[si++] as T);
    return out;
  }

  // Restart / cold load: weave markers into server Q&A by saved afterQaCount.
  markers.sort((a, b) => a.afterQaCount - b.afterQaCount || a.at.localeCompare(b.at));
  const byCount = new Map<number, VisitMarkerRow[]>();
  for (const m of markers) {
    const list = byCount.get(m.afterQaCount) ?? [];
    list.push(m);
    byCount.set(m.afterQaCount, list);
  }
  const out: T[] = [];
  for (let i = 0; i <= serverQA.length; i++) {
    const atPos = byCount.get(i);
    if (atPos) {
      for (const r of atPos) {
        out.push({ role: "visit_marker", content: r.content, at: r.at } as T);
      }
    }
    if (i < serverQA.length) out.push(serverQA[i]!);
  }
  return out;
}
