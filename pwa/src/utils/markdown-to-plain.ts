/**
 * Markdown → readable plain text for the clipboard (port of the desktop
 * web/src/utils/markdown-to-plain.ts), plus mobile-specific cleanup of the
 * inline-cell markers the mobile engine stores in message content.
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

/**
 * Plain text of a stored message: markdown stripped, [CELL_N] placeholders
 * (and raw [CELL …] blocks from un-closed streams) removed entirely — the
 * cell bodies live in the message's cells, not in the text.
 */
export function messagePlainText(content: string): string {
  if (!content) return "";
  let out = content.replace(/\[CELL_\d+\]/g, "");
  out = out.replace(/\[CELL[^\]]*\][\s\S]*?(?:\[\/CELL[^\]]*\]|$)/g, "");
  out = out.replace(/ +([,.;:!?])/g, "$1");
  return markdownToPlainText(out);
}
