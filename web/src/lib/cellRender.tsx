// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import type { ReactNode } from "react";
import type { DisplayCell } from "./messageCells";

export type CellSegment =
  | { kind: "text"; value: string }
  | { kind: "cell"; index: number };

/** Split content with [CELL_N] placeholders without capturing-group confusion. */
export function splitCellPlaceholders(content: string): CellSegment[] {
  const re = /\[CELL_(\d+)\]/g;
  const out: CellSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) {
      out.push({ kind: "text", value: content.slice(last, m.index) });
    }
    out.push({ kind: "cell", index: Number.parseInt(m[1], 10) });
    last = m.index + m[0].length;
  }
  if (last < content.length) {
    out.push({ kind: "text", value: content.slice(last) });
  }
  return out;
}

/** Relative /files/... → absolute against apiBase (empty apiBase = same-origin). */
export function resolveMediaSrc(url: string, apiBase: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return `${apiBase.replace(/\/$/, "")}${trimmed}`;
  }
  return trimmed;
}

export function renderCellSegments(
  content: string,
  cells: DisplayCell[],
  renderText: (text: string, key: string) => ReactNode,
  renderCell: (cell: DisplayCell, index: number, key: string) => ReactNode
): ReactNode[] {
  const segments = splitCellPlaceholders(content);
  if (segments.length === 0 && content) {
    return [renderText(content, "text-0")];
  }
  // Cells exist but no placeholders — show text, then cells in order
  if (cells.length > 0 && !segments.some((s) => s.kind === "cell")) {
    const nodes: ReactNode[] = [];
    if (content.trim()) nodes.push(renderText(content, "text-raw"));
    cells.forEach((cell, i) => nodes.push(renderCell(cell, i, `cell-append-${i}`)));
    return nodes;
  }
  const referenced = new Set<number>();
  const nodes = segments.map((seg, i) => {
    if (seg.kind === "text") {
      return seg.value ? renderText(seg.value, `text-${i}`) : null;
    }
    referenced.add(seg.index);
    const cell = cells[seg.index];
    if (!cell) return null;
    return renderCell(cell, seg.index, `cell-${i}-${seg.index}`);
  });
  // Valid cells without a placeholder (broken [CELL_0] + live [CELL_1] in meta) — still show them
  cells.forEach((cell, i) => {
    if (referenced.has(i)) return;
    if (!(cell.content ?? "").trim()) return;
    nodes.push(renderCell(cell, i, `cell-orphan-${i}`));
  });
  return nodes;
}
