// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Sidebar attachment flags (attachmentRefsByChat): /files/ links, bare
 * relative output|uploads refs (the SQL prefilter used to skip those rows
 * entirely while the documents panel counted them), image cells, and plain
 * text without references.
 *
 * Run: npx tsx src/gateway/db/chat-repository-attachments.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, initDb } from "./init.js";
import type { ChatRepository } from "./chat-repository.js";

const tempDirs: string[] = [];

function freshRepo(): ChatRepository {
  const dir = mkdtempSync(join(tmpdir(), "claw2-attach-test-"));
  tempDirs.push(dir);
  return initDb(join(dir, "chats.db"));
}

const USER = "user-attach-test";

{
  const repo = freshRepo();

  repo.ensureChat("chat-files", USER, "Files");
  repo.appendMessage("chat-files", USER, "assistant", "Готово: [отчёт](/files/output/report.pdf)");

  // Bare relative ref without the /files/ prefix: same file the documents
  // panel lists, so the sidebar flag must light up too.
  repo.ensureChat("chat-bare", USER, "Bare");
  repo.appendMessage("chat-bare", USER, "assistant", "Сохранил в uploads/notes.txt");

  repo.ensureChat("chat-img", USER, "Img");
  repo.appendMessage("chat-img", USER, "user", "смотри", '{"cells":[{"type":"image","content":"/files/uploads/a.png"}]}');

  repo.ensureChat("chat-plain", USER, "Plain");
  repo.appendMessage("chat-plain", USER, "user", "просто текст");

  const refs = repo.attachmentRefsByChat(USER);
  assert.equal(refs.get("chat-files")?.docs, true, "/files/ document link flags docs");
  assert.equal(refs.get("chat-bare")?.docs, true, "bare output/uploads refs flag docs");
  assert.equal(refs.get("chat-img")?.images, true, "image cell flags images");
  assert.equal(refs.get("chat-plain"), undefined, "plain text flags nothing");
  closeDb();
}

for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
console.log("chat-repository-attachments.test.ts: ok");
