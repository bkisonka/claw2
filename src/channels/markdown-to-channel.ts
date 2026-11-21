// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Converting Markdown to Channel Format:
 * - Telegram: HTML (parse_mode: HTML)
 * - VK and others: readable plain text without raw markup
 */

const TELEGRAM_ESCAPE_RE = /[&<>]/g;
const TELEGRAM_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

function escapeTelegram(s: string): string {
  return s.replace(TELEGRAM_ESCAPE_RE, (ch) => TELEGRAM_ESCAPE_MAP[ch] ?? ch);
}

/**
 * Converts Markdown to Telegram HTML.
 * Supported: **bold**, *italic*, `code`, ```block```, [text](url), line breaks.
 * In Telegram, send with parse_mode: "HTML".
 */
export function markdownToTelegramHtml(md: string): string {
  if (!md || typeof md !== "string") return "";
  let out = md;

  // Blocks of code (before inline, so as not to touch the ``` inside)
  out = out.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    return "<pre>" + escapeTelegram(code.trimEnd()) + "</pre>";
  });
  // Inline code
  out = out.replace(/`([^`]+)`/g, (_, code) => {
    return "<code>" + escapeTelegram(code) + "</code>";
  });
  // Links [text](url). In the href attributes and in the text we also escape ", otherwise Telegram: "Empty attribute name in tag a"
  out = out.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_, text, url) => {
    const u = (url ?? "").trim();
    const t = (text ?? u).trim() || u;
    const safeUrl = escapeTelegram(u).replace(/"/g, "&quot;");
    const safeText = escapeTelegram(t).replace(/"/g, "&quot;");
    if (!u) return safeText || ""; // empty url - do not make <a> tag
    return '<a href="' + safeUrl + '">' + safeText + "</a>";
  });
  // Bold **text** (does not overlap with *_)
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, t) => "<b>" + escapeTelegram(t) + "</b>");
  out = out.replace(/__([^_]+)__/g, (_, t) => "<b>" + escapeTelegram(t) + "</b>");
  // Italics *text* and _text_ (singles, not **)
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, t) => "<i>" + escapeTelegram(t) + "</i>");
  out = out.replace(/(?<!_)_([^_]+)_(?!_)/g, (_, t) => "<i>" + escapeTelegram(t) + "</i>");

  // Escape & < > in text between tags (tags are already inserted, content inside tags is already escaped)
  const tagRe = /<(?:b|i|code|pre|a)(?:\s[^>]*)?>|<\/(?:b|i|code|pre|a)>/gi;
  const parts: string[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(out)) !== null) {
    if (m.index > lastIndex) {
      parts.push(escapeTelegram(out.slice(lastIndex, m.index)));
    }
    parts.push(m[0]);
    lastIndex = tagRe.lastIndex;
  }
  if (lastIndex < out.length) {
    parts.push(escapeTelegram(out.slice(lastIndex)));
  }
  return parts.length ? parts.join("") : escapeTelegram(out);
}

/**
 * Removes Markdown markup, leaving readable text (for channels without HTML support).
 */
export function markdownToPlainText(md: string): string {
  if (!md || typeof md !== "string") return "";
  let out = md;
  // Code blocks: leave content as is
  out = out.replace(/```\w*\n?([\s\S]*?)```/g, "$1");
  // Inline code: remove backticks
  out = out.replace(/`([^`]+)`/g, "$1");
  // Links [text](url) → text (url) or text
  out = out.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_, text, url) => (text?.trim() ? `${text.trim()} (${url.trim()})` : url.trim()));
  // Bold/italic: remove * and _
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/__([^_]+)__/g, "$1");
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1");
  out = out.replace(/(?<!_)_([^_]+)_(?!_)/g, "$1");
  return out;
}
