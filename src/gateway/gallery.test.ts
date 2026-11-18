import assert from "node:assert/strict";
import {
  collectGalleryImages,
  imageCellsFromUploads,
  markImageDeletedInMessages,
  IMAGE_DELETED_CELL_TYPE,
} from "./gallery.js";
import { cellsToMeta } from "../core/cell-blocks.js";
import type { SessionMessage } from "./db/chat-repository.js";

{
  const cells = imageCellsFromUploads([
    { path: "/tmp/agents/uploads/sess-0-photo.png", name: "photo.png", mimeType: "image/png" },
    { path: "/tmp/agents/uploads/sess-1-note.txt", name: "note.txt", mimeType: "text/plain" },
  ]);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].type, "image");
  assert.equal(cells[0].content, "/files/uploads/sess-0-photo.png");
}

{
  const messages: SessionMessage[] = [
    {
      role: "assistant",
      content: "look [CELL_0]",
      meta: cellsToMeta([{ type: "image", content: "/files/output/a.png" }]),
    },
    {
      role: "user",
      content: "See attached",
      meta: cellsToMeta([{ type: "image", content: "/files/uploads/u.png" }]),
    },
  ];
  const gallery = collectGalleryImages(messages);
  assert.equal(gallery.length, 2);

  const marked = markImageDeletedInMessages(messages, "/files/output/a.png");
  assert.equal(
    JSON.parse(marked[0].meta!).cells[0].type,
    IMAGE_DELETED_CELL_TYPE
  );
  assert.equal(JSON.parse(marked[0].meta!).cells[0].content, "/files/output/a.png");
  const after = collectGalleryImages(marked).filter((g) => !g.deleted);
  assert.equal(after.length, 1);
  assert.equal(after[0].path, "uploads/u.png");
}

console.log("gallery.test.ts: ok");
