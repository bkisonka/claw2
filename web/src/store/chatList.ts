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
  /** Transcript payload was dropped from memory and must be reloaded before display. */
  historyEvicted?: boolean;
}

/** Title from the first user message: first phrase or a shortened summary. */
export function makeChatTitle(messages: StoredMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser?.content?.trim()) return t("chat.listNewChat");
  return deriveChatTitleFromRequest(firstUser.content, t("chat.listNewChat"));
}

/** pinned → favorited → updatedAt DESC */
export function compareChatItems(a: ChatItem, b: ChatItem): number {
  const pin = Number(!!b.pinned) - Number(!!a.pinned);
  if (pin) return pin;
  const fav = Number(!!b.favorited) - Number(!!a.favorited);
  if (fav) return fav;
  return b.updatedAt - a.updatedAt;
}
