// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Contextual sidebar for the model (tools) + UI.
 * In-memory per sessionId; process lifetime.
 */

export type SidebarItemAction = "prompt" | "navigate" | "url";

export type SidebarItemIcon =
  | "bolt"
  | "file"
  | "folder"
  | "task"
  | "link"
  | "chat"
  | "search"
  | "settings"
  | "star"
  | "spark";

/** Task-like lifecycle for reinforcement / UI. */
export type SidebarItemStatus = "open" | "active" | "done";

export interface DynamicSidebarItem {
  id: string;
  label: string;
  icon?: SidebarItemIcon;
  action: SidebarItemAction;
  value: string;
  status: SidebarItemStatus;
  /** Optional short note (shown as title / returned to model). */
  note?: string;
}

export interface SidebarLastEvent {
  type: "click" | "mark" | "set" | "upsert" | "remove" | "clear";
  id?: string;
  label?: string;
  status?: SidebarItemStatus;
  at: number;
  detail?: string;
}

export interface DynamicSidebarState {
  title: string;
  items: DynamicSidebarItem[];
  updatedAt: number;
  lastEvent?: SidebarLastEvent;
}

const MAX_ITEMS = 8;
const MAX_LABEL = 48;
const MAX_VALUE = 2000;
const MAX_NOTE = 120;

const ICONS = new Set<SidebarItemIcon>([
  "bolt",
  "file",
  "folder",
  "task",
  "link",
  "chat",
  "search",
  "settings",
  "star",
  "spark",
]);

const ACTIONS = new Set<SidebarItemAction>(["prompt", "navigate", "url"]);
const STATUSES = new Set<SidebarItemStatus>(["open", "active", "done"]);

const bySession = new Map<string, DynamicSidebarState>();

/** Keep a recent user click visible to the model across tool rewrites in the same turn. */
const CLICK_PRESERVE_MS = 120_000;

function preserveClickLastEvent(
  prev: DynamicSidebarState | undefined,
  next: SidebarLastEvent
): SidebarLastEvent {
  if (next.type === "click" || next.type === "clear") return next;
  const click = prev?.lastEvent;
  if (
    click?.type === "click" &&
    typeof click.at === "number" &&
    Date.now() - click.at < CLICK_PRESERVE_MS
  ) {
    const toolBit = `${next.type}${next.detail ? `:${next.detail}` : ""}`;
    return {
      ...click,
      detail: click.detail ? `${click.detail}; then ${toolBit}` : `then ${toolBit}`,
    };
  }
  return next;
}

/** Static chrome the model cannot rewrite (for sidebar_get). */
export const SIDEBAR_CHROME = {
  fixed: [
    "new_chat — create a chat",
    "skills — /cabinet/skills",
    "search - search in chats",
    "projects — project tree",
    "chats - list of chats",
  ],
  conditional: [
    "gallery - appears when there are images in the chat (the model does not create the item manually)",
    "documents - appears when there are documents in the chat",
    "calls - with SIP enabled",
  ],
  rules: [
    "The contextual section (title + items) is the only area controlled by the model.",
    "Don't try to create/delete fixed/conditional chrome via sidebar_* - only contextual items.",
    "id is stable between upsert/mark; without id, the system will return item-N.",
    "status: open (default) | active (currently in progress) | done (done - update the menu or delete).",
    "After the user clicks on the item, lastEvent.type=click arrives - update the following steps.",
    "action=prompt: click sends value as a user message; navigate: path with /; url: http(s) only.",
  ],
} as const;

function normalizeIcon(v: unknown): SidebarItemIcon | undefined {
  const s = String(v ?? "").trim().toLowerCase();
  return ICONS.has(s as SidebarItemIcon) ? (s as SidebarItemIcon) : undefined;
}

function normalizeAction(v: unknown): SidebarItemAction | null {
  const s = String(v ?? "").trim().toLowerCase();
  return ACTIONS.has(s as SidebarItemAction) ? (s as SidebarItemAction) : null;
}

function normalizeStatus(v: unknown, fallback: SidebarItemStatus = "open"): SidebarItemStatus {
  const s = String(v ?? "").trim().toLowerCase();
  return STATUSES.has(s as SidebarItemStatus) ? (s as SidebarItemStatus) : fallback;
}

function sanitizeItem(
  raw: unknown,
  index: number,
  opts?: { requireActionValue?: boolean; existing?: DynamicSidebarItem }
): DynamicSidebarItem | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const existing = opts?.existing;
  const label = String(o.label ?? existing?.label ?? "")
    .trim()
    .slice(0, MAX_LABEL);
  const valueRaw = o.value !== undefined ? String(o.value ?? "").trim() : existing?.value ?? "";
  const value = valueRaw.slice(0, MAX_VALUE);
  const action =
    o.action !== undefined ? normalizeAction(o.action) : existing?.action ?? null;
  if (opts?.requireActionValue !== false) {
    if (!label || !value || !action) return null;
  } else {
    if (!label && !existing) return null;
  }
  if (!label || !value || !action) return null;
  if (action === "navigate" && !value.startsWith("/")) return null;
  if (action === "url" && !/^https?:\/\//i.test(value)) return null;
  const id =
    String(o.id ?? existing?.id ?? `item-${index + 1}`)
      .trim()
      .slice(0, 64) || `item-${index + 1}`;
  const noteRaw = o.note !== undefined ? String(o.note ?? "").trim() : existing?.note;
  const note = noteRaw ? noteRaw.slice(0, MAX_NOTE) : undefined;
  const status = normalizeStatus(o.status, existing?.status ?? "open");
  const icon = o.icon !== undefined ? normalizeIcon(o.icon) : existing?.icon;
  return { id, label, action, value, status, icon, note };
}

function emptyState(): DynamicSidebarState {
  return { title: "", items: [], updatedAt: Date.now() };
}

export function sidebarGet(sessionId: string): DynamicSidebarState {
  const key = sessionId.trim() || "anon";
  return bySession.get(key) ?? emptyState();
}

/** Tool-facing snapshot: contextual state + chrome rules. */
export function sidebarGetSnapshot(sessionId: string): {
  contextual: DynamicSidebarState;
  chrome: typeof SIDEBAR_CHROME;
  summary: string;
} {
  const contextual = sidebarGet(sessionId);
  const summary = formatSidebarForPrompt(contextual);
  return { contextual, chrome: SIDEBAR_CHROME, summary };
}

export function formatSidebarForPrompt(sb: DynamicSidebarState): string {
  if (sb.items.length === 0) {
    let s = "The sidebar contextual menu is empty.";
    if (sb.lastEvent) {
      s += ` lastEvent: ${sb.lastEvent.type}${sb.lastEvent.label ? ` «${sb.lastEvent.label}»` : ""} @${sb.lastEvent.at}.`;
    }
    return s;
  }
  const titlePart = sb.title.trim() ? `«${sb.title.trim()}»` : "(no title)";
  const lines = sb.items.map((it, i) => {
    const note = it.note ? ` — ${it.note}` : "";
    return `${i + 1}. id=${it.id} [${it.status}] [${it.action}] ${it.label}${note}`;
  });
  let out = `Contextual menu ${titlePart}:\n${lines.join("\n")}`;
  if (sb.lastEvent) {
    out += `\nlastEvent: ${sb.lastEvent.type}${sb.lastEvent.id ? ` id=${sb.lastEvent.id}` : ""}${
      sb.lastEvent.label ? ` «${sb.lastEvent.label}»` : ""
    }${sb.lastEvent.status ? ` → ${sb.lastEvent.status}` : ""}.`;
  }
  return out;
}

export function sidebarSet(
  sessionId: string,
  params: { title?: string; items?: unknown[] }
): { ok: true; state: DynamicSidebarState } | { ok: false; error: string } {
  const key = sessionId.trim() || "anon";
  const rawItems = Array.isArray(params.items) ? params.items : [];
  if (rawItems.length > MAX_ITEMS) {
    return { ok: false, error: `max ${MAX_ITEMS} items` };
  }
  const items: DynamicSidebarItem[] = [];
  for (let i = 0; i < rawItems.length; i++) {
    const item = sanitizeItem(rawItems[i], i);
    if (item) items.push(item);
  }
  const title = String(params.title ?? "").trim().slice(0, 40);
  const prev = bySession.get(key);
  const state: DynamicSidebarState = {
    title,
    items,
    updatedAt: Date.now(),
    lastEvent: preserveClickLastEvent(prev, {
      type: "set",
      at: Date.now(),
      detail: `${items.length} items`,
    }),
  };
  bySession.set(key, state);
  return { ok: true, state };
}

export function sidebarUpsert(
  sessionId: string,
  params: { title?: string; items?: unknown[] }
): { ok: true; state: DynamicSidebarState } | { ok: false; error: string } {
  const key = sessionId.trim() || "anon";
  const current = sidebarGet(key);
  const rawItems = Array.isArray(params.items) ? params.items : [];
  if (rawItems.length === 0) {
    return { ok: false, error: "items required" };
  }
  const byId = new Map(current.items.map((it) => [it.id, it]));
  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i];
    const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const idHint = String(o.id ?? "").trim();
    const existing = idHint ? byId.get(idHint) : undefined;
    const item = sanitizeItem(raw, current.items.length + i, { existing });
    if (!item) {
      return { ok: false, error: `invalid item at index ${i}` };
    }
    byId.set(item.id, item);
  }
  if (byId.size > MAX_ITEMS) {
    return { ok: false, error: `max ${MAX_ITEMS} items after upsert` };
  }
  const items = [...byId.values()];
  const title =
    params.title !== undefined ? String(params.title ?? "").trim().slice(0, 40) : current.title;
  const state: DynamicSidebarState = {
    title,
    items,
    updatedAt: Date.now(),
    lastEvent: preserveClickLastEvent(current, {
      type: "upsert",
      at: Date.now(),
      detail: `upserted ${rawItems.length}`,
    }),
  };
  bySession.set(key, state);
  return { ok: true, state };
}

export function sidebarRemove(
  sessionId: string,
  params: { ids?: unknown }
): { ok: true; state: DynamicSidebarState } | { ok: false; error: string } {
  const key = sessionId.trim() || "anon";
  const current = sidebarGet(key);
  const ids = Array.isArray(params.ids)
    ? params.ids.map((x) => String(x ?? "").trim()).filter(Boolean)
    : [];
  if (ids.length === 0) return { ok: false, error: "ids required" };
  const drop = new Set(ids);
  const items = current.items.filter((it) => !drop.has(it.id));
  const state: DynamicSidebarState = {
    title: current.title,
    items,
    updatedAt: Date.now(),
    lastEvent: preserveClickLastEvent(current, {
      type: "remove",
      at: Date.now(),
      detail: ids.join(","),
    }),
  };
  bySession.set(key, state);
  return { ok: true, state };
}

export function sidebarMark(
  sessionId: string,
  params: { id?: unknown; status?: unknown }
): { ok: true; state: DynamicSidebarState } | { ok: false; error: string } {
  const key = sessionId.trim() || "anon";
  const current = sidebarGet(key);
  const id = String(params.id ?? "").trim();
  if (!id) return { ok: false, error: "id required" };
  const status = normalizeStatus(params.status, "done");
  const idx = current.items.findIndex((it) => it.id === id);
  if (idx < 0) return { ok: false, error: `item not found: ${id}` };
  const items = current.items.slice();
  items[idx] = { ...items[idx], status };
  const state: DynamicSidebarState = {
    title: current.title,
    items,
    updatedAt: Date.now(),
    lastEvent: preserveClickLastEvent(current, {
      type: "mark",
      id,
      label: items[idx].label,
      status,
      at: Date.now(),
    }),
  };
  bySession.set(key, state);
  return { ok: true, state };
}

/** UI click: mark done + record lastEvent for the model. */
export function sidebarClick(
  sessionId: string,
  itemId: string
): { ok: true; state: DynamicSidebarState; item: DynamicSidebarItem } | { ok: false; error: string } {
  const key = sessionId.trim() || "anon";
  const current = sidebarGet(key);
  const id = String(itemId ?? "").trim();
  const idx = current.items.findIndex((it) => it.id === id);
  if (idx < 0) return { ok: false, error: `item not found: ${id}` };
  const item = { ...current.items[idx], status: "done" as const };
  const items = current.items.slice();
  items[idx] = item;
  const state: DynamicSidebarState = {
    title: current.title,
    items,
    updatedAt: Date.now(),
    lastEvent: {
      type: "click",
      id: item.id,
      label: item.label,
      status: "done",
      at: Date.now(),
      detail: `${item.action}:${item.value.slice(0, 80)}`,
    },
  };
  bySession.set(key, state);
  return { ok: true, state, item };
}

export function sidebarClear(sessionId: string): DynamicSidebarState {
  const key = sessionId.trim() || "anon";
  const empty: DynamicSidebarState = {
    title: "",
    items: [],
    updatedAt: Date.now(),
    lastEvent: { type: "clear", at: Date.now() },
  };
  bySession.set(key, empty);
  return empty;
}

/** Deletes the session key instead of retaining an empty sidebar record. */
export function releaseSidebarSession(sessionId: string): boolean {
  const key = sessionId.trim() || "anon";
  return bySession.delete(key);
}

/**
 * Move contextual sidebar from one session key to another (e.g. legacy "anon" → real chat id).
 * No-op if from===to, from empty, or to already has items.
 */
export function sidebarMigrate(
  fromSessionId: string,
  toSessionId: string
): DynamicSidebarState | null {
  const from = (fromSessionId.trim() || "anon");
  const to = (toSessionId.trim() || "anon");
  if (from === to) return sidebarGet(to);
  const src = bySession.get(from);
  if (!src || (src.items.length === 0 && !src.title.trim())) return null;
  const dest = bySession.get(to);
  if (dest && (dest.items.length > 0 || dest.title.trim())) return null;
  bySession.set(to, { ...src, updatedAt: Date.now() });
  bySession.delete(from);
  return bySession.get(to) ?? null;
}
