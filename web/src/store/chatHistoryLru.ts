import type { ChatItem } from "./chatList";

export const MAX_LOADED_INACTIVE_HISTORIES = 10;

/**
 * Select the least-recently-used loaded, inactive histories above the cache limit.
 * Protected histories do not consume the inactive-history budget.
 */
export function selectInactiveHistoryEvictions(
  chats: readonly ChatItem[],
  protectedChatIds: ReadonlySet<string>,
  lastAccessedAt: ReadonlyMap<string, number>,
  maxLoaded = MAX_LOADED_INACTIVE_HISTORIES
): string[] {
  const candidates = chats.filter(
    (chat) => chat.messages.length > 0 && !protectedChatIds.has(chat.id)
  );
  const overflow = candidates.length - Math.max(0, maxLoaded);
  if (overflow <= 0) return [];

  return candidates
    .slice()
    .sort((a, b) => {
      const accessDiff =
        (lastAccessedAt.get(a.id) ?? a.updatedAt) - (lastAccessedAt.get(b.id) ?? b.updatedAt);
      return accessDiff || a.id.localeCompare(b.id);
    })
    .slice(0, overflow)
    .map((chat) => chat.id);
}

/** Drop transcript payloads while retaining every piece of sidebar metadata. */
export function evictChatHistories(
  chats: ChatItem[],
  chatIds: ReadonlySet<string>
): ChatItem[] {
  let changed = false;
  const next = chats.map((chat) => {
    if (!chatIds.has(chat.id) || chat.messages.length === 0) return chat;
    changed = true;
    return { ...chat, messages: [], historyEvicted: true };
  });
  return changed ? next : chats;
}
