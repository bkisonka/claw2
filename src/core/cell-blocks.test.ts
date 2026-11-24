// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Unit checks for CELL parsing / streaming.
 * Run: npx tsx src/core/cell-blocks.test.ts
 */
import assert from "node:assert/strict";
import {
  parseCellBlocks,
  contentForLlmHistory,
  stripOrphanCellPlaceholders,
  expandCellPlaceholders,
  resolveAssistantCells,
  cellsToMeta,
  cellsFromMeta,
  interruptedByFromMeta,
} from "./cell-blocks.js";
import {
  filterMissingLocalImageCells,
  filterLocalImageCellsWithoutTool,
} from "./cell-image-filters.js";

function streamLikeChatBugFixed(chunks: string[]) {
  let raw = "";
  let lastContent = "";
  let lastCells: { type: string; content: string }[] = [];
  for (const chunk of chunks) {
    raw += chunk;
    const resolved = parseCellBlocks(raw);
    lastContent = resolved.cells.length > 0 ? resolved.content : raw;
    lastCells = resolved.cells.length > 0 ? resolved.cells : lastCells;
  }
  return { content: lastContent, cells: lastCells };
}

{
  const r = parseCellBlocks(`A [CELL type="html"]<b>1</b>[/CELL] B [CELL type="html"]<i>2</i>[/CELL] C`);
  assert.equal(r.content, "A [CELL_0] B [CELL_1] C");
  assert.equal(r.cells.length, 2);
  assert.equal(r.cells[0].content, "<b>1</b>");
  assert.equal(r.cells[1].content, "<i>2</i>");
}

{
  const r = parseCellBlocks(`[CELL type="audio"]http://x.com/a.mp3[/CELL]`);
  assert.equal(r.cells[0].type, "audio");
  assert.equal(r.cells[0].content, "http://x.com/a.mp3");
}

{
  const r = parseCellBlocks(`[CELL type="audio"]javascript:alert(1)[/CELL]`);
  assert.equal(r.cells.length, 0);
  assert.doesNotMatch(r.content, /CELL_/);
}

{
  // A broken URL should not leave an empty cell next to a valid one
  const r = parseCellBlocks(
    `A [CELL type="image"]javascript:evil()[/CELL] B [CELL type="image"]/files/output/ok.png[/CELL]`
  );
  assert.equal(r.cells.length, 1);
  assert.equal(r.cells[0].content, "/files/output/ok.png");
  assert.equal(r.content, "A  B [CELL_0]");
}

{
  const tick = parseCellBlocks(`[CELL type="image"]\`/files/output/generated-1.png\`[/CELL]`);
  assert.equal(tick.cells.length, 1);
  assert.equal(tick.cells[0].content, "/files/output/generated-1.png");
}

{
  const r = parseCellBlocks(`[CELL type="image"]/files/foo.png[/CELL]`);
  assert.equal(r.cells[0].content, "/files/foo.png");
}

{
  const r = parseCellBlocks(`[CELL type="image" alt="F-22 Raptor"]f22_raptor.jpg[/CELL]`);
  assert.equal(r.cells.length, 1);
  assert.equal(r.cells[0].type, "image");
  assert.equal(r.cells[0].content, "/files/output/f22_raptor.jpg");
  assert.equal(r.content, "[CELL_0]");
}

{
  const r = parseCellBlocks(`[CELL type="image"]agents/output/photo.png[/CELL]`);
  assert.equal(r.cells[0].content, "/files/output/photo.png");
}

{
  const r = parseCellBlocks(`[CELL type="image"]/files/agents/output/brent.png[/CELL]`);
  assert.equal(r.cells[0].content, "/files/output/brent.png");
}

{
  // Stream: a trimmed URL without an extension should not become a cell (otherwise img → 404 forever)
  const mid = parseCellBlocks(`[CELL type="image"]/files/output/chart-1784746`);
  assert.equal(mid.cells.length, 0);
  const done = parseCellBlocks(
    `[CELL type="image"]/files/output/chart-1784746332998.png\nещё текст`
  );
  assert.equal(done.cells.length, 1);
  assert.equal(done.cells[0].content, "/files/output/chart-1784746332998.png");
}

{
  // The model cut off the closing tag: `[/CELL` without `]` - previously raw markup was poured into the chat
  const truncated = parseCellBlocks(
    `Готово: [CELL type="image"]/files/output/generated-1785085518066.png[/CELL`
  );
  assert.equal(truncated.cells.length, 1);
  assert.equal(truncated.cells[0].content, "/files/output/generated-1785085518066.png");
  assert.equal(truncated.content, "Готово: [CELL_0]");
  assert.doesNotMatch(truncated.content, /\[CELL type=/i);
}

{
  const parsed = parseCellBlocks(
    `ok [CELL type="image"]/files/output/generated-missing-xyz.png[/CELL] end`
  );
  const filtered = filterMissingLocalImageCells(parsed, process.cwd() + "/agents");
  assert.equal(filtered.cells.length, 0);
  assert.match(filtered.content, /image is not available/i);
}

{
  const hallucinated = parseCellBlocks(
    `x [CELL type="image"]/files/output/generated-999.png[/CELL]`
  );
  const stripped = filterLocalImageCellsWithoutTool(hallucinated, {
    generateImageSucceeded: false,
  });
  assert.equal(stripped.cells.length, 0);
  assert.match(stripped.content, /generate_image/);

  const chart = parseCellBlocks(`c [CELL type="image"]/files/output/chart-1.png[/CELL]`);
  const keepChart = filterLocalImageCellsWithoutTool(chart, { generateImageSucceeded: false });
  assert.equal(keepChart.cells.length, 1);

  const dropOnIntent = filterLocalImageCellsWithoutTool(chart, {
    generateImageSucceeded: false,
    imageIntent: true,
  });
  assert.equal(dropOnIntent.cells.length, 0);
}

{
  const r = parseCellBlocks(`[CELL type="image"]![x](https://cdn.ex/a.jpg)[/CELL]`);
  assert.equal(r.cells[0].content, "https://cdn.ex/a.jpg");
}

{
  const r = parseCellBlocks(`[CELL type="html"]<a href="https://ex.com">x</a>[/CELL]`);
  assert.match(r.cells[0].content, /target="_blank"/);
  assert.match(r.cells[0].content, /rel="noopener noreferrer"/);
}

{
  const r = parseCellBlocks(`[CELL type="html"]<a href="javascript:alert(1)">x</a>[/CELL]`);
  assert.doesNotMatch(r.cells[0].content, /javascript:/i);
}

{
  const streamed = streamLikeChatBugFixed([
    "Hello ",
    `[CELL type="html"]<p>one</p>[/CELL]`,
    " and ",
    `[CELL type="audio"]http://ex.com/a.mp3[/CELL]`,
    " end",
  ]);
  assert.equal(streamed.content, "Hello [CELL_0] and [CELL_1] end");
  assert.equal(streamed.cells.length, 2);
  assert.equal(streamed.cells[0].type, "html");
  assert.equal(streamed.cells[1].type, "audio");
}

{
  const expanded = expandCellPlaceholders("See [CELL_0] here", [
    { type: "image", content: "https://ex.com/a.png" },
  ]);
  assert.match(expanded, /previous image in this chat/);
  assert.doesNotMatch(expanded, /https:\/\/ex\.com\/a\.png/);

  const forLlm = contentForLlmHistory(
    "text [CELL_0] more",
    JSON.stringify({ cells: [{ type: "audio", content: "http://x/a.mp3" }] })
  );
  assert.equal(forLlm, 'text [CELL type="audio"]http://x/a.mp3[/CELL] more');

  assert.equal(stripOrphanCellPlaceholders("Hi [CELL_0]\n\nBye"), "Hi\n\nBye");
  assert.equal(contentForLlmHistory("F-22 [CELL_0] meow"), "F-22 meow");

  const orphan = resolveAssistantCells("Вот [CELL_0]\nготово");
  assert.equal(orphan.cells.length, 0);
  assert.doesNotMatch(orphan.content, /CELL_/);
}

{
  // The metadata of an answer: its cells, and — for one cut short — what cut it.
  const cell = { type: "image", content: "/files/output/a.png" };
  assert.equal(cellsToMeta([]), undefined);
  assert.deepEqual(JSON.parse(cellsToMeta([cell])!), { cells: [cell] });
  assert.equal(cellsToMeta([], "gateway_restart"), '{"interruptedBy":"gateway_restart"}');
  const both = cellsToMeta([cell], "gateway_restart")!;
  assert.deepEqual(cellsFromMeta(both), [cell]);
  assert.equal(interruptedByFromMeta(both), "gateway_restart");
  assert.equal(interruptedByFromMeta(cellsToMeta([cell])), undefined);
  assert.equal(interruptedByFromMeta("not json"), undefined);
  assert.equal(interruptedByFromMeta('{"interruptedBy":"something else"}'), undefined);
  // The model gets to know it, not an empty message.
  assert.equal(contentForLlmHistory("", '{"interruptedBy":"gateway_restart"}'), "[no answer: the gateway was restarting]");
  assert.equal(contentForLlmHistory("", undefined), "");
}

console.log("cell-blocks tests: ok");
