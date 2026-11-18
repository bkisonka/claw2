import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatItem } from "./chatList";
import { evictChatHistories, selectInactiveHistoryEvictions } from "./chatHistoryLru";

function chat(id: string, updatedAt: number, extra: Partial<ChatItem> = {}): ChatItem {
  return {
    id,
    title: `Chat ${id}`,
    updatedAt,
    messages: [{ role: "user", content: id }],
    projectId: "project",
    favorited: true,
    ...extra,
  };
}

describe("inactive chat history LRU", () => {
  it("evicts the least recently accessed inactive histories above the limit", () => {
    const chats = [chat("a", 100), chat("b", 200), chat("c", 300)];
    const access = new Map([
      ["a", 30],
      ["b", 10],
      ["c", 20],
    ]);

    assert.deepEqual(selectInactiveHistoryEvictions(chats, new Set(), access, 1), ["b", "c"]);
  });

  it("always protects current, streaming, and pinned chats", () => {
    const chats = [
      chat("current", 1),
      chat("streaming", 2),
      chat("pinned", 3, { pinned: true }),
      chat("inactive-old", 4),
      chat("inactive-new", 5),
    ];
    const protectedIds = new Set(["current", "streaming", "pinned"]);

    assert.deepEqual(
      selectInactiveHistoryEvictions(chats, protectedIds, new Map(), 1),
      ["inactive-old"]
    );
  });

  it("does not evict provisional, empty, or already evicted histories", () => {
    const chats = [
      chat("loaded", 1),
      chat("provisional", 2, { messages: [] }),
      chat("evicted", 3, { messages: [], historyEvicted: true }),
    ];

    assert.deepEqual(selectInactiveHistoryEvictions(chats, new Set(), new Map(), 0), ["loaded"]);
  });

  it("preserves metadata and marks only loaded histories as evicted", () => {
    const loaded = chat("loaded", 1, { pinned: false, model: "model-a" });
    const empty = chat("empty", 2, { messages: [] });
    const result = evictChatHistories([loaded, empty], new Set(["loaded", "empty"]));

    assert.deepEqual(result[0], {
      ...loaded,
      messages: [],
      historyEvicted: true,
    });
    assert.strictEqual(result[1], empty);
  });
});
