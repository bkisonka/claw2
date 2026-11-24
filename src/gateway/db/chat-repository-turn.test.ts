// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteChatRepository } from "./chat-repository.js";

const chatId = "test-chat";
const userId = "test-owner";
const user = { content: "Question", meta: '{"cells":[{"type":"image","content":"/files/uploads/a.png"}]}' };
const assistant = { content: "Answer [CELL_0]", meta: '{"cells":[{"type":"chart","content":"[]"}]}' };
const recap = { summary: "Current recap", coveredCount: 1 };
const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

let db: Database.Database;
let repo: SqliteChatRepository;

function historyStores() {
  return ["messages", "transcript_messages"].map((table) =>
    db.prepare(`SELECT role, content, meta FROM ${table} WHERE chat_id = ? ORDER BY id`).all(chatId));
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(schema);
  repo = new SqliteChatRepository(db);
  repo.ensureChat(chatId, userId, "Example");
});
afterEach(() => db.close());

describe("SQLite chat turn append", () => {
  it("writes both stores in turn order, preserves metadata, and updates the recap", () => {
    db.prepare("UPDATE chats SET updated_at = 1 WHERE id = ?").run(chatId);
    repo.appendTurn(chatId, userId, user, assistant, recap);
    const expected = [{ role: "user", ...user }, { role: "assistant", ...assistant }];
    expect(historyStores()).toEqual([expected, expected]);
    expect(repo.getPromptContext(chatId, userId)).toEqual(recap);
    expect(repo.listChats(userId)[0]?.updated_at).toBeGreaterThan(1);
  });

  it.each([
    "BEFORE INSERT ON transcript_messages WHEN NEW.role = 'assistant'",
    "BEFORE UPDATE OF prompt_summary ON chats",
  ])("rolls back both stores and the timestamp on failure (%s)", (trigger) => {
    repo.appendMessage(chatId, userId, "user", "Existing message");
    repo.setPromptContext(chatId, userId, "Previous recap", 1);
    db.prepare("UPDATE chats SET updated_at = 1 WHERE id = ?").run(chatId);
    const before = historyStores();
    db.exec(`CREATE TRIGGER reject_turn ${trigger} BEGIN SELECT RAISE(ABORT, 'test write failure'); END;`);

    expect(() => repo.appendTurn(chatId, userId, user, assistant, recap)).toThrow("test write failure");
    expect(historyStores()).toEqual(before);
    expect(repo.getPromptContext(chatId, userId)).toEqual({ summary: "Previous recap", coveredCount: 1 });
    expect(repo.listChats(userId)[0]?.updated_at).toBe(1);
  });

  it("refuses to append either a turn or a single message to a chat owned by someone else", () => {
    expect(() => repo.appendTurn(chatId, "another-user", user, assistant, recap)).toThrow("Chat not found");
    expect(() => repo.appendMessage(chatId, "another-user", "user", "Message")).toThrow("Chat not found");
    expect(historyStores()).toEqual([[], []]);
  });
});

describe("SQLite chat tool trace", () => {
  const tools = [
    { seq: 0, iteration: 0, name: "read", args: '{"path":"a.txt"}', result: "first", ok: true, durationMs: 12, untrusted: false },
    { seq: 1, iteration: 1, name: "web_fetch", args: '{"url":"https://x.test/"}', result: "page", ok: true, durationMs: 900, untrusted: true },
  ];
  const stored = (turnIndex: number, step: number, name: string) => ({
    turnIndex,
    step,
    iteration: tools[step]!.iteration,
    name,
    args: tools[step]!.args,
    result: tools[step]!.result,
    ok: true,
    untrusted: tools[step]!.untrusted,
    durationMs: tools[step]!.durationMs,
    createdAt: expect.any(Number),
  });

  it("stores a turn's tool calls in the same transaction and lists them by turn", () => {
    repo.appendTurn(chatId, userId, user, assistant, undefined, tools);
    // An interrupted call has no result, no status and no duration.
    repo.appendTurn(chatId, userId, { content: "Second" }, { content: "Again" }, undefined, [
      { seq: 0, iteration: 0, name: "run_agent", args: '{"script":"a.js"}' },
    ]);
    expect(repo.listToolCalls(chatId, userId)).toEqual([
      stored(0, 0, "read"),
      stored(0, 1, "web_fetch"),
      { turnIndex: 2, step: 0, iteration: 0, name: "run_agent", args: '{"script":"a.js"}', result: null, ok: null, untrusted: false, durationMs: null, createdAt: expect.any(Number) },
    ]);
    expect(repo.listToolCalls(chatId, "another-user")).toEqual([]);
  });

  it("rolls the whole turn back when a tool call cannot be stored", () => {
    repo.appendTurn(chatId, userId, user, assistant);
    db.exec("CREATE TRIGGER reject_tool BEFORE INSERT ON tool_calls BEGIN SELECT RAISE(ABORT, 'test write failure'); END;");
    const before = historyStores();

    expect(() => repo.appendTurn(chatId, userId, user, assistant, recap, tools)).toThrow("test write failure");

    expect(historyStores()).toEqual(before);
    expect(repo.listToolCalls(chatId, userId)).toEqual([]);
    expect(repo.getPromptContext(chatId, userId)).toBeNull();
  });
});
