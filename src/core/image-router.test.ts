// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Tests for image-router (intent + hallucination heuristics).
 */
import assert from "node:assert/strict";
import {
  shouldHintImage,
  historyHasImageCell,
  looksLikeImageCellWithoutTool,
} from "./image-router.js";

assert.equal(shouldHintImage("нарисуй зимний лес"), true);
assert.equal(shouldHintImage("generate an image of a cat"), true);
assert.equal(shouldHintImage("что такое рекурсия"), false);
assert.equal(shouldHintImage("добавь оленя"), false);
assert.equal(shouldHintImage("добавь оленя", { historyHasImage: true }), true);
assert.equal(shouldHintImage("измени картинку", { historyHasImage: true }), true);

assert.equal(
  historyHasImageCell([
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content:
        '[CELL type="image"](previous image in this chat — call generate_image)[/CELL]',
    },
  ]),
  true
);
assert.equal(historyHasImageCell([{ role: "assistant", content: "просто текст" }]), false);

assert.equal(
  looksLikeImageCellWithoutTool('[CELL type="image"]/files/output/generated-1.png[/CELL]'),
  true
);
assert.equal(looksLikeImageCellWithoutTool("без картинки"), false);

console.log("image-router tests: ok");
