// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Chat gallery: collecting image-CELL from history and marking deleted links.
 */
import { basename } from "node:path";
import {
  cellsToMeta,
  resolveAssistantCells,
  type ParsedCell,
} from "../core/cell-blocks.js";
import type { SessionMessage } from "./db/chat-repository.js";

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg)$/i;

export const IMAGE_DELETED_CELL_TYPE = "image_deleted";

export function isImagePath(nameOrUrl: string): boolean {
  return IMAGE_EXT_RE.test(nameOrUrl.trim());
}

export function normalizeImageRef(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function imageRefAlts(imageUrl: string): Set<string> {
  const target = normalizeImageRef(imageUrl);
  const altTargets = new Set([target]);
  if (target.startsWith("/files/")) altTargets.add(target.slice("/files/".length));
  else altTargets.add(`/files/${target.replace(/^\/+/, "")}`);
  return altTargets;
}

function refsMatch(cellContent: string, altTargets: Set<string>): boolean {
  const ref = normalizeImageRef(cellContent);
  return altTargets.has(ref) || altTargets.has(ref.replace(/^\/files\//, ""));
}

/** Unique pictures from chat messages (the order is the same as in history). Includes user + assistant.*/
export function collectGalleryImages(
  messages: SessionMessage[]
): Array<{ url: string; name: string; path: string; deleted?: boolean }> {
  const seen = new Set<string>();
  const out: Array<{ url: string; name: string; path: string; deleted?: boolean }> = [];
  for (const m of messages) {
    if (m.role !== "assistant" && m.role !== "user") continue;
    const { cells } = resolveAssistantCells(m.content, m.meta);
    for (const cell of cells) {
      if (cell.type !== "image" && cell.type !== IMAGE_DELETED_CELL_TYPE) continue;
      const raw = (cell.content ?? "").trim();
      if (!raw || !isImagePath(raw)) continue;
      const key = normalizeImageRef(raw);
      if (seen.has(key)) continue;
      seen.add(key);
      const path = raw.startsWith("/files/")
        ? raw.slice("/files/".length)
        : raw.replace(/^\/+/, "");
      const name = path.split("/").filter(Boolean).pop() ?? path;
      out.push({
        url: raw.startsWith("/files/") ? raw : `/files/${path}`,
        name,
        path,
        ...(cell.type === IMAGE_DELETED_CELL_TYPE ? { deleted: true } : {}),
      });
    }
  }
  return out;
}

/** Marks image-CELL as deleted by the user (the link is saved).*/
export function markImageDeletedInMessages(
  messages: SessionMessage[],
  imageUrl: string
): SessionMessage[] {
  const altTargets = imageRefAlts(imageUrl);

  return messages.map((m) => {
    if (m.role !== "assistant" && m.role !== "user") return m;
    const resolved = resolveAssistantCells(m.content, m.meta);
    if (!resolved.cells.length) return m;
    let changed = false;
    const cells: ParsedCell[] = resolved.cells.map((cell) => {
      if (cell.type !== "image" && cell.type !== IMAGE_DELETED_CELL_TYPE) return cell;
      if (!refsMatch(cell.content ?? "", altTargets)) return cell;
      changed = true;
      return { type: IMAGE_DELETED_CELL_TYPE, content: cell.content };
    });
    if (!changed) return m;
    const meta = cellsToMeta(cells);
    return {
      role: m.role,
      content: resolved.content,
      ...(meta ? { meta } : {}),
    };
  });
}

/** @deprecated Use markImageDeletedInMessages - scrub erases links from the feed.*/
export function scrubImageUrlFromMessages(
  messages: SessionMessage[],
  imageUrl: string
): SessionMessage[] {
  return markImageDeletedInMessages(messages, imageUrl);
}

/** Cells for image attachments → /files/uploads/….*/
export function imageCellsFromUploads(
  saved: Array<{ path: string; name: string; mimeType?: string }>
): ParsedCell[] {
  const cells: ParsedCell[] = [];
  for (const s of saved) {
    const fileName = basename(s.path);
    const looksImage =
      (typeof s.mimeType === "string" && s.mimeType.startsWith("image/")) ||
      isImagePath(s.name) ||
      isImagePath(fileName);
    if (!looksImage || !fileName) continue;
    cells.push({ type: "image", content: `/files/uploads/${fileName}` });
  }
  return cells;
}
