// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { duplicateChat, type ChatSummary, type StoredMessage } from "./db";

const chats = new Map<string, ChatSummary>();
const messages: StoredMessage[] = [];

// Minimal IndexedDB fixture for the requests made by duplicateChat. Requests
// run in order and completion waits for requests enqueued by success handlers.
function transaction() {
  const pending: (() => void)[] = [];
  const tx = {
    oncomplete: () => {},
    objectStore: (name: string) => name === "chats" ? {
      get(id: string) {
        return request(() => chats.get(id));
      },
      add(chat: ChatSummary) {
        pending.push(() => { chats.set(chat.id, structuredClone(chat)); });
      },
      put(chat: ChatSummary) {
        pending.push(() => { chats.set(chat.id, structuredClone(chat)); });
      },
    } : {
      add(message: StoredMessage) {
        pending.push(() => { messages.push(structuredClone(message)); });
      },
      index: () => ({
        openCursor(chatId: string) {
          const rows = messages.filter((m) => m.chatId === chatId);
          let index = 0;
          const cursorReq = request(next);
          function next() {
            if (index >= rows.length) return null;
            return {
              value: rows[index++],
              continue: () => pending.push(() => {
                cursorReq.result = next();
                cursorReq.onsuccess();
              }),
            };
          }
          return cursorReq;
        },
      }),
    },
  };
  function request<T>(read: () => T) {
    const req = { result: undefined as T | undefined, onsuccess: () => {} };
    pending.push(() => {
      req.result = read();
      req.onsuccess();
    });
    return req;
  }
  queueMicrotask(() => {
    while (pending.length) pending.shift()!();
    tx.oncomplete();
  });
  return tx;
}

beforeAll(() => {
  vi.stubGlobal("IDBKeyRange", { only: (id: string) => id });
  vi.stubGlobal("indexedDB", { open: () => {
    const req = { result: { transaction }, onsuccess: () => {} };
    queueMicrotask(() => req.onsuccess());
    return req;
  } });
});
afterAll(() => vi.unstubAllGlobals());

it.each([
  { cutoff: undefined, covered: 2, expected: 2, count: 4 },
  { cutoff: 2.9, covered: 2, expected: 2, count: 2 },
  { cutoff: 2, covered: 3, expected: null, count: 2 },
  { cutoff: 0, covered: 2, expected: null, count: 0 },
  { cutoff: 12, covered: 5, expected: null, count: 4 },
  { cutoff: undefined, covered: 5, expected: null, count: 4 },
])("inherits only covered recaps (cutoff $cutoff, covered $covered)", async ({ cutoff, covered, expected, count }) => {
  chats.clear();
  messages.length = 0;
  const promptContext = { summary: "source recap", coveredCount: covered };
  chats.set("source", { id: "source", title: "Source title", updated_at: 0, pinnedProviderId: "provider", promptContext });
  for (let i = 0; i < 4; i++) {
    messages.push({ id: i + 1, chatId: "source", content: `message ${i}`, role: i % 2 ? "assistant" : "user", createdAt: i });
  }

  expect(await duplicateChat("source", { newId: "fork", upToCount: cutoff })).toBe("fork");
  expect(chats.get("source")?.promptContext).toEqual(promptContext);
  expect(chats.get("fork")).toMatchObject({
    title: "Source title",
    forkedFrom: "source",
    pinnedProviderId: "provider",
    promptContext: expected === null ? null : { ...promptContext, coveredCount: expected },
  });
  const forkMessages = messages.filter((m) => m.chatId === "fork");
  expect(forkMessages.map((m) => m.content)).toEqual(Array.from({ length: count }, (_, i) => `message ${i}`));
  expect(forkMessages.every((m) => m.id === undefined)).toBe(true);
});
