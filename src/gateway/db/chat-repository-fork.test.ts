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
  assert.ok(repo.getChatHistory("chat-fork", USER).length === 4, "transcript_messages copied as well");
  assert.equal(repo.getForkParent("chat-src", USER), null);
  closeDb();
}

{
  const repo = freshRepo();
  repo.ensureChat("chat-src", USER, "Branched chat");
  for (let i = 0; i < 5; i++) repo.appendMessage("chat-src", USER, "user", `msg-${i}`);

  // Truncated fork: only the first 3 messages, prompt context untouched.
  repo.setPromptContext("chat-src", USER, "summary", 5);
  const partialId = repo.duplicateChat(USER, "chat-src", "chat-fork-3", { upToCount: 3 });
  assert.ok(partialId);
  assert.equal(repo.getMessages("chat-fork-3", USER).length, 3);
  assert.equal(repo.getMessages("chat-fork-3", USER)[2]?.content, "msg-2");
  assert.deepEqual(repo.getPromptContext("chat-fork-3", USER), { summary: "summary", coveredCount: 5 });

  // upToCount = 0: metadata-only fork with no history.
  const emptyId = repo.duplicateChat(USER, "chat-src", "chat-fork-0", { upToCount: 0 });
  assert.ok(emptyId);
  assert.equal(repo.getMessages("chat-fork-0", USER).length, 0);
  assert.equal(repo.getForkParent("chat-fork-0", USER), "chat-src");

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

for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
console.log("chat-repository-fork.test.ts: ok");
