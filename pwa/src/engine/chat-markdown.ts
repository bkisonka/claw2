/**
 * Chat → markdown export, the mobile counterpart of the desktop
 * "Экспорт в MD". Same shape as the desktop builder: title heading,
 * "Экспорт: {date}" line, then "## Вы" / "## Агент" sections. Inline
 * [CELL] blocks render as fenced code (html/json); media cells and
 * attached files are noted instead of inlining base64 payloads.
 */

export type MarkdownExportMessage = {
  role: "user" | "assistant";
  content: string;
  cells?: { type: string; content: string }[];
  attachedFiles?: { name: string; deleted?: boolean }[];
  createdAt?: number;
};

const CELL_PLACEHOLDER = /\[CELL_(\d+)\]/g;

function fence(lang: string, body: string): string {
  return "```" + lang + "\n" + body.trim() + "\n```";
}

/** Render one cell for the export; media cells become a note, not base64. */
export function renderCellForExport(cell: { type: string; content: string }): string | null {
  switch (cell.type) {
    case "html":
      return fence("html", cell.content);
    case "chart":
      return fence("json", cell.content);
    case "image":
      return "*[изображение — сохранено в приложении, вкладка «Картинки»]*";
    case "audio":
      return "*[аудио — сохранено в приложении]*";
    case "video":
      return "*[видео — сохранено в приложении]*";
    default:
      return fence("", cell.content);
  }
}

function messageBody(m: MarkdownExportMessage): string {
  const parts: string[] = [];
  const cells = m.cells ?? [];
  let last = 0;
  for (const match of m.content.matchAll(CELL_PLACEHOLDER)) {
    if (match.index > last) parts.push(m.content.slice(last, match.index));
    const cell = cells[Number(match[1])];
    if (cell) {
      const rendered = renderCellForExport(cell);
      if (rendered) parts.push("", rendered, "");
    }
    last = match.index + match[0].length;
  }
  if (last < m.content.length) parts.push(m.content.slice(last));
  const text = parts.join("").trim();
  const files = (m.attachedFiles ?? []).filter((f) => !f.deleted);
  const fileLines = files.length
    ? (text ? "\n\n" : "") + files.map((f) => `> 📎 ${f.name}`).join("\n")
    : "";
  return (text || "*(пусто)*") + fileLines;
}

/**
 * The full document. Kept byte-compatible with the desktop export:
 * `# title`, "Экспорт: {date}", then `## Вы` / `## Агент` sections.
 */
export function buildChatMarkdown(opts: {
  title: string;
  date?: Date;
  messages: MarkdownExportMessage[];
}): string {
  const date = opts.date ?? new Date();
  const lines: string[] = [`# ${opts.title}`, "", `Экспорт: ${date.toLocaleString("ru-RU")}`, ""];
  for (const m of opts.messages) {
    lines.push(`## ${m.role === "user" ? "Вы" : "Агент"}`, "", messageBody(m), "");
  }
  return lines.join("\n");
}

/** Desktop-compatible filename: sanitize, cap at 50 chars, .md. */
export function markdownFileName(title: string): string {
  const base = title.replace(/[^\p{L}\p{N}\s_-]/gu, "_").trim().slice(0, 50);
  return `${base || "chat"}.md`;
}
