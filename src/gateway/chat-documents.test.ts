// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import assert from "node:assert/strict";
import { cellsToMeta } from "../core/cell-blocks.js";
import {
  collectChatDocuments,
  isDocumentPath,
  mergeChatDocuments,
} from "./chat-documents.js";
import type { SessionMessage } from "./db/chat-repository.js";

assert.equal(isDocumentPath("report.docx"), true);
assert.equal(isDocumentPath("pic.png"), false);

{
  const messages: SessionMessage[] = [
    {
      role: "assistant",
      content: "Готово: /files/output/output_2026.docx и ещё chart.png",
    },
    {
      role: "user",
      content: "See attached",
      meta: cellsToMeta([{ type: "image", content: "/files/uploads/x.png" }]),
    },
  ];
  const docs = collectChatDocuments(messages);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].name, "output_2026.docx");
}

{
  const merged = mergeChatDocuments(
    [{ url: "/files/output/a.pdf", name: "a.pdf", path: "output/a.pdf", ext: ".pdf" }],
    [{ url: "/files/output/a.pdf", name: "a.pdf", path: "output/a.pdf", ext: ".pdf" }],
    [{ url: "/files/uploads/b.txt", name: "b.txt", path: "uploads/b.txt", ext: ".txt" }]
  );
  assert.equal(merged.length, 2);
}

console.log("chat-documents.test.ts: ok");
