/**
 * Image-CELL server filters (requires node:fs). Do not import from web bundle.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ParseCellBlocksResult, ParsedCell } from "./cell-blocks.js";

/**
 * Removes image cells from /files/output|uploads/... if the file is not on disk
 * (the model often comes up with generated-….png without calling generate_image).
 */
export function filterMissingLocalImageCells(
  parsed: ParseCellBlocksResult,
  agentsDir: string
): ParseCellBlocksResult {
  if (!parsed.cells.length) return parsed;
  const missingNote =
    "(the image is not available: there is no file - you need to call generate_image again and paste the exact URL from the tool response)";
  const keepFlags = parsed.cells.map((cell) => {
    if (cell.type !== "image") return true;
    const url = (cell.content ?? "").trim();
    const m = url.match(/^\/files\/(output|uploads)\/([^/\\]+)$/i);
    if (!m) return true;
    const sub = m[1].toLowerCase();
    const name = m[2];
    const primary = resolve(agentsDir, sub, name);
    if (existsSync(primary)) return true;
    // Fallback: cwd/agents (legacy gateway /files path) if agentsDir is absolute elsewhere
    const legacy = resolve(process.cwd(), "agents", sub, name);
    if (legacy !== primary && existsSync(legacy)) return true;
    return false;
  });
  if (keepFlags.every(Boolean)) return parsed;
  return remapCellsAfterFilter(parsed, keepFlags, missingNote);
}

/**
 * Without a successful generate_image this turn:
 * — always removes /files/…/generated-*.(png|jpg|…) (typical hallucination);
 * — with imageIntent removes any local /files/output|uploads image-CELL
 * (you cannot “update” an image by copying the old URL).
 * We don’t touch paths like chart-*.png from run_agent if there is no imageIntent.
 */
export function filterLocalImageCellsWithoutTool(
  parsed: ParseCellBlocksResult,
  opts: { generateImageSucceeded: boolean; imageIntent?: boolean }
): ParseCellBlocksResult {
  if (opts.generateImageSucceeded || !parsed.cells.length) return parsed;
  const note =
    "(the image was not generated: a generate_image call is needed; the path from the history cannot be copied)";
  const keepFlags = parsed.cells.map((cell) => {
    if (cell.type !== "image") return true;
    const url = (cell.content ?? "").trim();
    if (!/^\/files\/(output|uploads)\//i.test(url)) return true;
    if (/\/generated-\d+\.(?:png|jpe?g|webp|gif)$/i.test(url)) return false;
    if (opts.imageIntent) return false;
    return true;
  });
  if (keepFlags.every(Boolean)) return parsed;
  return remapCellsAfterFilter(parsed, keepFlags, note);
}

function remapCellsAfterFilter(
  parsed: ParseCellBlocksResult,
  keepFlags: boolean[],
  missingNote: string
): ParseCellBlocksResult {
  let content = parsed.content;
  const kept: ParsedCell[] = [];
  for (let i = parsed.cells.length - 1; i >= 0; i--) {
    const ph = `[CELL_${i}]`;
    if (!keepFlags[i]) {
      content = content.split(ph).join(missingNote);
      continue;
    }
    const newIdx = keepFlags.slice(0, i).filter(Boolean).length;
    const newPh = `[CELL_${newIdx}]`;
    if (ph !== newPh) content = content.split(ph).join(newPh);
  }
  for (let i = 0; i < parsed.cells.length; i++) {
    if (keepFlags[i]) kept.push(parsed.cells[i]);
  }
  return { content, cells: kept };
}
