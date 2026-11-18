import type { TranscriptListItem, TranscriptSessionAccess } from "./types.js";
import {
  TRANSCRIPT_LIST_DEFAULT_LIMIT,
  TRANSCRIPT_LIST_MAX_LIMIT,
  TRANSCRIPT_TOC_MAX_CHARS,
  TRANSCRIPT_TOC_MAX_ENTRIES,
  TRANSCRIPT_TOC_PREVIEW_CHARS,
} from "./types.js";

function formatListLine(item: TranscriptListItem): string {
  return `${item.messageId} ${item.role} ts=${item.createdAt}: ${item.preview}`;
}

function formatTocLine(item: TranscriptListItem): string {
  return `${item.messageId} ${item.role}: ${item.preview}`;
}

/**
 * The first page of transcript_list is inserted into the prompt immediately after summarize.
 */
export function buildTranscriptListFirstPageBlock(
  access: TranscriptSessionAccess,
  pageLimit = TRANSCRIPT_LIST_DEFAULT_LIMIT
): string {
  const limit = Math.max(1, Math.min(pageLimit, TRANSCRIPT_LIST_MAX_LIMIT));
  const page = access.list({ limit });
  if (!page.items.length) return "";

  const lines = page.items.map(formatListLine).join("\n");
  const minId = page.items[0]?.messageId;
  const footer = [
    minId != null ? `minId=${minId}` : null,
    `total=${page.totalCount}`,
    page.nextAfterId != null ? `nextAfterId=${page.nextAfterId}` : "end",
  ]
    .filter(Boolean)
    .join(", ");

  const pagination =
    page.nextAfterId != null
      ? `Next pages: transcript_list(afterId=${page.nextAfterId}).`
      : "";

  const minIdNote =
    minId != null
      ? `messageId — id from the database (here from ${minId}), not serial number 1,2,3...`
      : "messageId - id from the list, not a serial number 1,2,3...";

  return `[Transcript · list - first page already loaded]${lines}

[${footer}]
${pagination ? `${pagination}\n` : ""}${minIdNote} Next step: transcript_read(fromId, toId) - copy the messageId from the lines above. DO NOT call transcript_list(afterId=0) again. transcript_search - only if the substring is already known verbatim.`;
}

/**
 * Compact table of contents of the transcript for the system prompt after summarize.
 * Map id → preview, without full text.
 */
export function buildTranscriptTocBlock(
  access: TranscriptSessionAccess,
  opts?: { maxEntries?: number; previewChars?: number; maxChars?: number }
): string {
  const maxEntries = opts?.maxEntries ?? TRANSCRIPT_TOC_MAX_ENTRIES;
  const previewChars = opts?.previewChars ?? TRANSCRIPT_TOC_PREVIEW_CHARS;
  const maxChars = opts?.maxChars ?? TRANSCRIPT_TOC_MAX_CHARS;

  const lines: string[] = [];
  let afterId: number | undefined;
  let totalCount = 0;
  let listed = 0;

  while (listed < maxEntries) {
    const pageSize = Math.min(TRANSCRIPT_LIST_MAX_LIMIT, maxEntries - listed);
    const page = access.list({ afterId, limit: pageSize });
    if (page.totalCount > 0) totalCount = page.totalCount;
    if (!page.items.length) break;

    for (const item of page.items) {
      const preview =
        item.preview.length > previewChars
          ? `${item.preview.slice(0, Math.max(1, previewChars - 1))}…`
          : item.preview;
      const line = formatTocLine({ ...item, preview });
      const nextLen = lines.join("\n").length + line.length + 1;
      if (lines.length > 0 && nextLen > maxChars) {
        lines.push(`... (table of contents cut off; transcript_list(afterId=${item.messageId - 1}) - continuation)`);
        return wrapToc(lines, totalCount);
      }
      lines.push(line);
      listed++;
      if (listed >= maxEntries) break;
    }

    if (page.nextAfterId == null) break;
    afterId = page.nextAfterId;
  }

  if (!lines.length) return "";
  if (totalCount > listed) {
    lines.push(`... total ${totalCount} messages; transcript_list — full crawl by id`);
  }
  return wrapToc(lines, totalCount);
}

function wrapToc(lines: string[], totalCount: number): string {
  const body = lines.join("\n");
  const header = `[Transcript · transcript table of contents${totalCount > 0 ? `, ${totalCount} msgs` : ""}]`;
  return `${header}\n${body}\n\nScheme: id from the list → transcript_read(fromId/toId). transcript_list - only for nextAfterId. transcript_search - only with a known substring.`;
}
