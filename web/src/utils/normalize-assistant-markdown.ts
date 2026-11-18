/**
 * Normalize assistant text for markdown display.
 * Some models (e.g. MiniMax) emit a JSON string with literal `\n` instead of real newlines,
 * which breaks headings/lists in react-markdown.
 */
export function normalizeAssistantMarkdown(content: string): string {
  let s = content;
  if (!s) return s;

  // Whole payload wrapped as a JSON string: "....\n...."
  const trimmed = s.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string" && parsed.length > 0) s = parsed;
    } catch {
      // keep original
    }
  }

  // Truncation prefix meant for LLM context — strip if model echoed it into the reply.
  s = s.replace(/^…\s*\[сообщение сокращено[^\]]*\]\s*"?/u, "");

  const realNewlines = (s.match(/\n/g) ?? []).length;
  const escapedNewlines = (s.match(/\\n/g) ?? []).length;
  if (escapedNewlines > 0 && escapedNewlines >= Math.max(realNewlines, 1)) {
    s = s
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"');
  }

  if (s.endsWith('"') && (s.match(/"/g) ?? []).length === 1) {
    s = s.slice(0, -1);
  }

  return s;
}
