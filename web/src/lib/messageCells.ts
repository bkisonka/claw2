import { resolveAssistantCells, type ParsedCell } from "../../../src/core/cell-blocks";

export type DisplayCell = ParsedCell;

/** Prepare an assistant message for render: cells from the API response or parse raw [CELL] in content. */
export function resolveAssistantDisplay(msg: {
  content: string;
  cells?: DisplayCell[];
}): { content: string; cells: DisplayCell[] } {
  const hasPlaceholders = /\[CELL_\d+\]/.test(msg.content);
  const hasRawTags = /\[CELL\s+type\s*=/i.test(msg.content);

  // Cells already present and placeholders intact — as returned by gateway/history.
  if (msg.cells && msg.cells.length > 0 && hasPlaceholders && !hasRawTags) {
    return { content: msg.content, cells: msg.cells };
  }

  // Raw tags in content (stream / old history) — always re-parse.
  if (hasRawTags) {
    return resolveAssistantCells(msg.content);
  }

  if (msg.cells && msg.cells.length > 0) {
    return { content: msg.content, cells: msg.cells };
  }

  // Bare [CELL_N] without cells (model copied a placeholder) — strip from text.
  return resolveAssistantCells(msg.content);
}
