// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Capability-note helpers for the provider card: notes is a comma-separated
 * free-form string (consumed by the router dispatcher prompt), edited in the
 * UI as a checklist of standard capabilities + custom ones.
 */

/** Standard capabilities offered as ready-made checkboxes (order = UI order). */
export const STANDARD_CAPS = [
  "код",
  "математика",
  "творческие тексты",
  "работа с документами",
  "длинный контекст",
  "инструменты",
  "быстрая",
];

/** notes string → token list (trimmed, no empties, deduped case-insensitively). */
export function parseNotes(notes: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of (notes ?? "").split(",")) {
    const token = raw.trim();
    if (!token) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

/** Token list → notes string. */
export function serializeNotes(tokens: string[]): string {
  return tokens.join(", ");
}

/** Toggle a token in the list (match case-insensitively, keep stored casing). */
export function toggleToken(tokens: string[], token: string): string[] {
  const key = token.toLowerCase();
  const has = tokens.some((t) => t.toLowerCase() === key);
  if (has) return tokens.filter((t) => t.toLowerCase() !== key);
  return [...tokens, token];
}

/** Rename a custom token in place. */
export function renameToken(tokens: string[], from: string, to: string): string[] {
  const key = from.toLowerCase();
  return tokens.map((t) => (t.toLowerCase() === key ? to.trim() : t));
}
