// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Fork/duplicate chat: duplicateChat copies row + history (full or truncated),
 * deleteChat grafts children onto the deleted chat's parent.
 *
 * Run: npx tsx src/gateway/db/chat-repository-fork.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, initDb } from "./init.js";
import type { ChatRepository } from "./chat-repository.js";

const tempDirs: string[] = [];

function freshRepo(): ChatRepository {
  const dir = mkdtempSync(join(tmpdir(), "claw2-fork-test-"));
  tempDirs.push(dir);
  return initDb(join(dir, "chats.db"));
}

const USER = "user-fork-test";

{
  const repo = freshRepo();
  const projectId = repo.createProject(USER, "Fork project", "goal").id;

  repo.ensureChat("chat-src", USER, "Source chat");
  repo.updateChatProject("chat-src", USER, projectId);
  repo.updateChatModel("chat-src", USER, "model-x");
  repo.updateChatPinned("chat-src", USER, true);
  repo.updateChatFavorited("chat-src", USER, true);
  repo.appendMessage("chat-src", USER, "user", "Вопрос?");
  repo.appendMessage("chat-src", USER, "assistant", "Ответ", '{"cells":[{"type":"image","content":"/files/output/x.png"}]}');
  repo.appendMessage("chat-src", USER, "user", "Уточнение");
  repo.appendMessage("chat-src", USER, "assistant", "Итог");
  repo.setPromptContext("chat-src", USER, "Recap of the covered region", 2);

  const srcMessages = repo.getMessages("chat-src", USER);
  assert.equal(srcMessages.length, 4);

  const forkId = repo.duplicateChat(USER, "chat-src", "chat-fork");
  assert.ok(forkId === "chat-fork");

  const fork = repo.listChats(USER).find((c) => c.id === "chat-fork");
  assert.ok(fork);
  assert.equal(fork.forked_from_chat_id, "chat-src");
  assert.equal(fork.title, "Source chat");
  assert.equal(fork.project_id, projectId);
  assert.equal(fork.model, "model-x");
  assert.equal(fork.pinned, false, "pinned is reset on the fork");
  assert.equal(fork.favorited, false, "favorited is reset on the fork");

  const forkMessages = repo.getMessages("chat-fork", USER);
  assert.equal(forkMessages.length, srcMessages.length);
  for (let i = 0; i < srcMessages.length; i++) {
    assert.equal(forkMessages[i]?.role, srcMessages[i]?.role);
    assert.equal(forkMessages[i]?.content, srcMessages[i]?.content);
    assert.equal(forkMessages[i]?.meta, srcMessages[i]?.meta, "meta (cells) copied verbatim");
  }
  assert.deepEqual(repo.getPromptContext("chat-fork", USER), { summary: "Recap of the covered region", coveredCount: 2 });
  assert.equal(repo.listTranscript("chat-fork", USER).totalCount, 4, "transcript_messages copied as well");
  assert.equal(repo.getForkParent("chat-src", USER), null);
  closeDb();
}

{
  const repo = freshRepo();
  repo.ensureChat("chat-src", USER, "Branched chat");
  for (let i = 0; i < 5; i++) repo.appendMessage("chat-src", USER, "user", `msg-${i}`);

  // A recap ahead of the cutoff must be discarded, not clamped to the cutoff.
  repo.setPromptContext("chat-src", USER, "summary", 5);
  const partialId = repo.duplicateChat(USER, "chat-src", "chat-fork-3", { upToCount: 3 });
  assert.ok(partialId);
  assert.equal(repo.getMessages("chat-fork-3", USER).length, 3);
  assert.equal(repo.getMessages("chat-fork-3", USER)[2]?.content, "msg-2");
  repo.appendMessage("chat-fork-3", USER, "user", "new branch message");
  assert.equal(repo.getPromptContext("chat-fork-3", USER), null);
  assert.deepEqual(repo.getPromptContext("chat-src", USER), { summary: "summary", coveredCount: 5 });

  repo.setPromptContext("chat-src", USER, "early summary", 3);
  repo.duplicateChat(USER, "chat-src", "chat-fork-exact", { upToCount: 3.9 });
  assert.deepEqual(repo.getPromptContext("chat-fork-exact", USER), { summary: "early summary", coveredCount: 3 });

  // A requested limit is not proof that those messages were actually copied.
  repo.setPromptContext("chat-src", USER, "stale summary", 6);
  repo.duplicateChat(USER, "chat-src", "chat-fork-short", { upToCount: 10 });
  assert.equal(repo.getMessages("chat-fork-short", USER).length, 5);
  assert.equal(repo.getPromptContext("chat-fork-short", USER), null);
  const fullId = repo.duplicateChat(USER, "chat-src", "chat-fork-stale-full");
  assert.ok(fullId);
  assert.equal(repo.getPromptContext(fullId, USER), null, "full copies also reject invalid coverage");

  // upToCount = 0: metadata-only fork with no history.
  const emptyId = repo.duplicateChat(USER, "chat-src", "chat-fork-0", { upToCount: 0 });
  assert.ok(emptyId);
  assert.equal(repo.getMessages("chat-fork-0", USER).length, 0);
  assert.equal(repo.getForkParent("chat-fork-0", USER), "chat-src");
  assert.equal(repo.getPromptContext("chat-fork-0", USER), null);

  // Custom title override; unknown source chat rejected.
  repo.duplicateChat(USER, "chat-src", "chat-fork-t", { title: "  Моя копия  " });
  assert.equal(repo.listChats(USER).find((c) => c.id === "chat-fork-t")?.title, "Моя копия");
  assert.equal(repo.duplicateChat(USER, "chat-missing", "chat-x"), null);
  closeDb();
}

{
  const repo = freshRepo();
  repo.ensureChat("chat-a", USER, "A");
  repo.appendMessage("chat-a", USER, "user", "root turn");
  repo.duplicateChat(USER, "chat-a", "chat-b", { title: "B" });
  repo.appendMessage("chat-b", USER, "assistant", "branch turn");
  repo.duplicateChat(USER, "chat-b", "chat-c", { title: "C" });
  repo.appendMessage("chat-c", USER, "assistant", "leaf turn");
  assert.equal(repo.getForkParent("chat-b", USER), "chat-a");
  assert.equal(repo.getForkParent("chat-c", USER), "chat-b");

  // Deleting the middle of the chain grafts the leaf onto the grandparent.
  assert.equal(repo.deleteChat("chat-b", USER), true);
  assert.equal(repo.getForkParent("chat-c", USER), "chat-a");
  assert.ok(repo.listChats(USER).every((c) => c.id !== "chat-b"));
  assert.equal(repo.getMessages("chat-c", USER).length, 3, "leaf keeps copied history");

  // Deleting the root detaches the remaining fork (no dangling parent).
  assert.equal(repo.deleteChat("chat-a", USER), true);
  assert.equal(repo.getForkParent("chat-c", USER), null);
  closeDb();
}

{
  // Tool traces follow their turn's assistant message into a fork.
  const repo = freshRepo();
  repo.ensureChat("chat-src", USER, "Traced chat");
  const tool = (name: string) => ({ seq: 0, iteration: 0, name, args: "{}", result: name, ok: true, durationMs: 1, untrusted: false });
  repo.appendTurn("chat-src", USER, { content: "q1" }, { content: "a1" }, undefined, [tool("read")]);
  repo.appendTurn("chat-src", USER, { content: "q2" }, { content: "a2" });
  repo.appendTurn("chat-src", USER, { content: "q3" }, { content: "a3" }, undefined, [tool("search")]);
  const names = (chatId: string) => repo.listToolCalls(chatId, USER).map((t) => [t.turnIndex, t.name]);
  assert.deepEqual(names("chat-src"), [[0, "read"], [4, "search"]]);

  repo.duplicateChat(USER, "chat-src", "chat-fork-full");
  assert.deepEqual(names("chat-fork-full"), [[0, "read"], [4, "search"]]);

  // Cut after the first answer: that turn's trace comes along, the later one does not.
  repo.duplicateChat(USER, "chat-src", "chat-fork-cut", { upToCount: 3 });
  assert.deepEqual(names("chat-fork-cut"), [[0, "read"]]);
  // Cut inside the first turn (before its answer): the trace of a turn without its answer is dropped.
  repo.duplicateChat(USER, "chat-src", "chat-fork-mid", { upToCount: 1 });
  assert.deepEqual(names("chat-fork-mid"), []);

  assert.deepEqual(repo.listToolCalls("chat-src", "someone-else"), [], "another user's chat exposes no trace");
  assert.equal(repo.deleteChat("chat-fork-full", USER), true);
  assert.deepEqual(names("chat-fork-full"), []);
  assert.equal(names("chat-src").length, 2, "deleting the fork leaves the source trace intact");
  closeDb();
}

for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
console.log("chat-repository-fork.test.ts: ok");
