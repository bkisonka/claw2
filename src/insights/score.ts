// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

const STOP = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "to",
  "of",
  "in",
  "on",
  "for",
  "is",
  "it",
  "this",
  "that",
  "with",
  "as",
  "at",
  "by",
  "from",
  "be",
  "are",
  "was",
  "were",
  "и",
  "в",
  "на",
  "с",
  "по",
  "к",
  "о",
  "об",
  "от",
  "за",
  "из",
  "у",
  "не",
  "что",
  "как",
  "это",
  "для",
  "а",
  "но",
  "же",
  "ли",
  "бы",
  "то",
  "так",
  "уже",
  "есть",
  "был",
  "была",
  "были",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

/** Jaccard over token sets; 0..1. */
export function lexicalOverlapScore(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) {
    if (tb.has(t)) inter++;
  }
  const union = ta.size + tb.size - inter;
  return union <= 0 ? 0 : inter / union;
}

/** Soft topical overlap: at least one shared token or Jaccard ≥ floor. */
export function hasSoftTopicalOverlap(query: string, haystack: string, floor = 0.08): boolean {
  const q = tokenize(query);
  if (q.length === 0) return false;
  const h = new Set(tokenize(haystack));
  if (h.size === 0) return false;
  let hits = 0;
  for (const t of q) {
    if (h.has(t)) hits++;
  }
  if (hits >= 1 && q.length <= 3) return true;
  if (hits >= 2) return true;
  return lexicalOverlapScore(query, haystack) >= floor;
}

const SHIFT_HINTS =
  /\b(раньше|раньше\s+думал|против|now|instead|передумал|изменил|раньше\s+был|used\s+to|changed\s+my\s+mind)\b/iu;
const SOLUTION_HINTS =
  /\b(решени[ея]|подход|можно\s+так|работает|fixed|solution|approach|workaround|обход)\b/iu;

export function classifySemanticReason(
  query: string,
  digestOrExcerpt: string
): "pattern" | "position_shift" | "solution_transfer" {
  const blob = `${query}\n${digestOrExcerpt}`;
  if (SHIFT_HINTS.test(blob)) return "position_shift";
  if (SOLUTION_HINTS.test(blob)) return "solution_transfer";
  return "pattern";
}
