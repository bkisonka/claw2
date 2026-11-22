// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/** Chat message (compatible with Chat.tsx). */
import { t } from "../i18n";
import { deriveChatTitleFromRequest } from "../../../src/core/chat-title";

export interface StoredMessage {
  role: "user" | "assistant" | "visit_marker";
  content: string;
  at?: string;
  attachedFiles?: { name: string; previewUrl?: string; deleted?: boolean }[];
  cells?: { type: string; content: string }[];
}

export interface ChatItem {
  id: string;
  title: string;
  updatedAt: number;
  messages: StoredMessage[];
  projectId?: string | null;
  /** Normalized browser URL — marks chat as browser-bound across restarts. */
  browserPageKey?: string | null;
  /** Per-chat model override; null = settings default. */
  model?: string | null;
  /** Pinned to top of sidebar. */
  pinned?: boolean;
  /** Favorited (star in sidebar). */
  favorited?: boolean;
  /** Fork lineage: id of the chat this one was duplicated/branched from; null = original. */
  forkedFrom?: string | null;
  /** Title was renamed manually: auto-titling is suppressed. */
  titleManual?: boolean;
  /** The chat has image attachments (sidebar indicator). */
  hasImages?: boolean;
  /** The chat has document attachments (sidebar indicator). */
  hasDocs?: boolean;
  /** Transcript payload was dropped from memory and must be reloaded before display. */
  historyEvicted?: boolean;
}

/** Title from the first user message: first phrase or a shortened summary. */
export function makeChatTitle(messages: StoredMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser?.content?.trim()) return t("chat.listNewChat");
  return deriveChatTitleFromRequest(firstUser.content, t("chat.listNewChat"));
}

/**
 * The localized "New chat" placeholder (i18n key chat.listNewChat) is not a
 * real title: rows are created with it — e.g. when a per-chat model override
 * is set before the first message — and it must give way to the derived or
 * loaded title later. Locale-independent on purpose (no t() at call time).
 */
const PLACEHOLDER_TITLES = new Set(["New chat", "Новый чат"]);

export function isPlaceholderChatTitle(title: string | null | undefined): boolean {
  const trimmed = (title ?? "").trim();
  return trimmed === "" || PLACEHOLDER_TITLES.has(trimmed);
}

/** Sidebar title: a real existing title wins; placeholders accept the new one. */
export function resolveListTitle(existing: string | null | undefined, incoming: string): string {
  if (isPlaceholderChatTitle(existing)) {
    const next = incoming.trim();
    return next && !PLACEHOLDER_TITLES.has(next) ? next : (existing ?? "").trim() || incoming.trim();
  }
  return (existing ?? "").trim();
}

/** pinned → favorited → updatedAt DESC */
export function compareChatItems(a: ChatItem, b: ChatItem): number {
  const pin = Number(!!b.pinned) - Number(!!a.pinned);
  if (pin) return pin;
  const fav = Number(!!b.favorited) - Number(!!a.favorited);
  if (fav) return fav;
  return b.updatedAt - a.updatedAt;
}

type ForkNode = Pick<ChatItem, "id" | "forkedFrom">;

/** True when the chat is part of a fork tree in the given list (has a fork parent or fork children). */
export function isInForkTree(chats: ForkNode[], chatId: string): boolean {
  const ids = new Set(chats.map((c) => c.id));
  const chat = chats.find((c) => c.id === chatId);
  if (!chat) return false;
  if (chat.forkedFrom && ids.has(chat.forkedFrom)) return true;
  return chats.some((c) => c.forkedFrom === chatId && ids.has(c.id));
}

/** All ids of the fork tree the chat belongs to: root ancestor plus every descendant. */
export function forkTreeIds(chats: ForkNode[], chatId: string): string[] {
  const byId = new Map(chats.map((c) => [c.id, c] as const));
  let root = byId.get(chatId);
  if (!root) return [chatId];
  const seen = new Set<string>([chatId]);
  while (root.forkedFrom && byId.has(root.forkedFrom) && !seen.has(root.forkedFrom)) {
    seen.add(root.forkedFrom);
    root = byId.get(root.forkedFrom)!;
  }
  const children = new Map<string, string[]>();
  for (const c of chats) {
    if (!c.forkedFrom) continue;
    const list = children.get(c.forkedFrom) ?? [];
    list.push(c.id);
    children.set(c.forkedFrom, list);
  }
  const out: string[] = [];
  const guard = new Set<string>();
  const stack = [root.id];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (guard.has(id)) continue;
    guard.add(id);
    out.push(id);
    for (const child of children.get(id) ?? []) stack.push(child);
  }
  return out;
}
