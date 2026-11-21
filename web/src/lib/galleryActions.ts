// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/** Shared gallery helpers / image actions in chat. */

export const IMAGE_DELETED_CELL_TYPE = "image_deleted";

export function imageFilenameFromUrl(url: string): string {
  const trimmed = url.trim();
  const path = trimmed.startsWith("/files/") ? trimmed.slice("/files/".length) : trimmed;
  return path.split("/").filter(Boolean).pop() || "image.png";
}

export function buildImageEditPrompt(imageUrlOrPath: string, edits: string): string {
  const path = imageUrlOrPath.trim().startsWith("/files/")
    ? imageUrlOrPath.trim()
    : `/files/${imageUrlOrPath.trim().replace(/^\/+/, "")}`;
  const name = imageFilenameFromUrl(path);
  return (
    `Отредактируй изображение ${name} через img2img. ` +
    `Обязательно вызови generate_image с параметрами: ` +
    `image="${path}", strength=0.65, ` +
    `prompt=(краткое описание сцены + правки на английском: ${edits.trim()}). ` +
    `Не копируй старый CELL и не выдумывай другой путь — в ответ только новый URL из ответа инструмента.`
  );
}

function imageRefAlts(imageUrl: string): Set<string> {
  const norm = (u: string) => u.trim().replace(/\/+$/, "");
  const target = norm(imageUrl);
  return new Set([target, target.replace(/^\/files\//, ""), `/files/${target.replace(/^\/+/, "")}`]);
}

/** Mark image cells as deleted by the user (link in the feed is kept). */
export function markImageDeletedInMessages<
  T extends {
    role: string;
    content: string;
    cells?: Array<{ type: string; content: string }>;
    attachedFiles?: { name: string; previewUrl?: string; deleted?: boolean }[];
  },
>(messages: T[], imageUrl: string): T[] {
  const alts = imageRefAlts(imageUrl);

  return messages.map((m) => {
    let next = m;
    if (m.cells?.length) {
      let changed = false;
      const cells = m.cells.map((c) => {
        if (c.type !== "image" && c.type !== IMAGE_DELETED_CELL_TYPE) return c;
        const ref = c.content.trim().replace(/\/+$/, "");
        if (!alts.has(ref) && !alts.has(ref.replace(/^\/files\//, ""))) return c;
        changed = true;
        return { type: IMAGE_DELETED_CELL_TYPE, content: c.content };
      });
      if (changed) next = { ...next, cells };
    }
    if (next.attachedFiles?.length) {
      const attachedFiles = next.attachedFiles.map((f) => {
        const url = (f.previewUrl ?? "").trim();
        if (!url) return f;
        const ref = url.replace(/\/+$/, "");
        if (!alts.has(ref) && !alts.has(ref.replace(/^\/files\//, ""))) return f;
        return { ...f, previewUrl: undefined, deleted: true };
      });
      if (attachedFiles.some((f, i) => f !== next.attachedFiles![i])) {
        next = { ...next, attachedFiles };
      }
    }
    return next;
  });
}

/** @deprecated → markImageDeletedInMessages */
export function stripImageFromMessages<
  T extends {
    role: string;
    content: string;
    cells?: Array<{ type: string; content: string }>;
    attachedFiles?: { name: string; previewUrl?: string; deleted?: boolean }[];
  },
>(messages: T[], imageUrl: string): T[] {
  return markImageDeletedInMessages(messages, imageUrl);
}
