// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Routing for image generation: heuristic “draw / add to the picture” + retry without tool_calls.
 * Level 1: hint when there is an explicit intent (and when editing, if there is already an image in the story).
 * Level 2: response with image-CELL or explicit intent without generate_image - one retry with a reminder.
 */

const IMAGE_INTENT_PHRASES = [
  "нарисуй",
  "нарисовать",
  "сгенерируй картин",
  "сгенерируй изображен",
  "сгенерируй фото",
  "создай картин",
  "создай изображен",
  "сделай картин",
  "сделай изображен",
  "сгенерируй image",
  "generate an image",
  "generate a picture",
  "generate image",
  "draw me",
  "draw a",
  "draw an",
  "create an image",
  "create a picture",
  "make an image",
  "make a picture",
  "txt2img",
  "text to image",
  "stable diffusion",
  "перерисуй",
  "дорисуй",
  "сгенерируй ещё",
  "сгенерируй еще",
  "другую картин",
  "новую картин",
  "новую изображен",
];

/** Editing an existing image - only if there was already an image in the history.*/
const IMAGE_EDIT_PHRASES = [
  "добавь",
  "убери",
  "удали",
  "замени",
  "измени",
  "поменяй",
  "сделай ярче",
  "сделай темнее",
  "добавь на картин",
  "добавь к картин",
  "добавь на изображен",
  "добавь к изображен",
  "на картинке",
  "на изображении",
  "в картинку",
  "в изображение",
  "edit the image",
  "add to the image",
  "change the image",
  "modify the image",
];

const IMAGE_CELL_RE = /\[CELL\s+type=["']?image\b/i;
const GENERATED_PATH_RE = /\/files\/output\/generated-\d+\.(?:png|jpe?g|webp)/i;

/** Level 1: user explicitly asks for an image / image edit. */
export function shouldHintImage(
  userInput: string,
  options?: { historyHasImage?: boolean }
): boolean {
  if (!userInput || typeof userInput !== "string") return false;
  const lower = userInput.trim().toLowerCase();
  if (!lower) return false;
  if (IMAGE_INTENT_PHRASES.some((p) => lower.includes(p))) return true;
  if (options?.historyHasImage && IMAGE_EDIT_PHRASES.some((p) => lower.includes(p))) return true;
  return false;
}

/** LLM history already has an image cell (including redacted). */
export function historyHasImageCell(
  history: Array<{ role: string; content?: string | null }>
): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.role !== "assistant") continue;
    const c = h.content ?? "";
    if (IMAGE_CELL_RE.test(c) || GENERATED_PATH_RE.test(c)) return true;
  }
  return false;
}

export const IMAGE_HINT_SUFFIX =
  "\n\n[System: for a new image call generate_image(prompt). To edit an existing one — generate_image(prompt, image=\"/files/output/….png\", strength≈0.65), passing the real file path. Do not insert [CELL] and do not invent paths — only the block from the tool response.]";

/** The answer looks like a fake image-CELL without calling the tool. */
export function looksLikeImageCellWithoutTool(content: string | null): boolean {
  if (!content || typeof content !== "string") return false;
  return IMAGE_CELL_RE.test(content) || GENERATED_PATH_RE.test(content);
}

export const IMAGE_REMINDER_MESSAGE =
  "You must call generate_image. For an edit pass image=\"/files/output/…\" (or /files/uploads/…) and a prompt describing the changes; for a new image — prompt only. Do not write [CELL] and do not invent paths. In the reply insert only FILE_URL / [CELL] from the tool response.";
