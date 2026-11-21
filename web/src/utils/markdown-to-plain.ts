// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Convert Markdown to readable plain text (for clipboard copy).
 */
export function markdownToPlainText(md: string): string {
  if (!md || typeof md !== "string") return "";
  let out = md;
  // Horizontal rules — remove or replace with a line break
  out = out.replace(/^---+$/gm, "\n");
  out = out.replace(/^\*\*\*+$/gm, "\n");
  out = out.replace(/^___+$/gm, "\n");
  // Headings ### Title -> Title (strip hashes)
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "$1");
  // Code blocks: keep the content
  out = out.replace(/```\w*\n?([\s\S]*?)```/g, "$1");
  // Inline code
  out = out.replace(/`([^`]+)`/g, "$1");
  // Links [text](url) -> text (url)
  out = out.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_, text, url) =>
    text?.trim() ? `${text.trim()} (${url.trim()})` : url.trim()
  );
  // Bold and italic
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/__([^_]+)__/g, "$1");
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1");
  out = out.replace(/(?<!_)_([^_]+)_(?!_)/g, "$1");
  // Collapse excess blank lines (more than two in a row → one)
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}
