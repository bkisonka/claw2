// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Chat title from the first user request:
 * the first phrase in its entirety, or a shortened summary if the phrase is too long.
 */

const MAX_TITLE_LEN = 56;
const FALLBACK = "Chat";

/** Normalizes spaces and removes service prefixes of attachments.*/
function normalizeRequestText(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/^(See attached files\.|См\. прикреплённые файлы\.|Прикреплено файлов:\s*\d+)\s*/i, "")
    .trim();
}

/** First phrase: until the end of the sentence / line break, otherwise the whole thing.*/
function firstPhrase(text: string): string {
  const m = text.match(/^(.+?[.!?…]+)(?:\s|$)/u);
  if (m?.[1]) return m[1].trim();
  const line = text.split(/\n/)[0]?.trim();
  return line || text;
}

/**
 * Shortens a long phrase at a word/punctuation mark boundary.
 * This is a “summary” without LLM: the meaning of the beginning of the query is preserved.
 */
function summarizeLongPhrase(phrase: string, maxLen: number): string {
  if (phrase.length <= maxLen) return phrase;
  const budget = Math.max(8, maxLen - 1);
  const slice = phrase.slice(0, budget);
  const breakAt = Math.max(
    slice.lastIndexOf(" "),
    slice.lastIndexOf(","),
    slice.lastIndexOf("—"),
    slice.lastIndexOf("-"),
    slice.lastIndexOf(":")
  );
  const base = (breakAt >= Math.floor(budget * 0.45) ? slice.slice(0, breakAt) : slice).trim();
  return `${base.replace(/[,:;.—\-]+$/u, "").trim()}…`;
}

/** Title from the text of the user's first request.*/
export function deriveChatTitleFromRequest(raw: string, fallback = FALLBACK): string {
  const text = normalizeRequestText(raw);
  if (!text) return fallback;
  const phrase = firstPhrase(text);
  if (!phrase) return fallback;
  return summarizeLongPhrase(phrase, MAX_TITLE_LEN) || fallback;
}

export const CHAT_TITLE_MAX_LEN = MAX_TITLE_LEN;
