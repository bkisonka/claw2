/**
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * Note appended to the user-facing reply when FRAGMENTED/CRITICAL by ΔS:
 * content may be contested or unverified (no retry).
 */

import type { HssCoherenceStatus, HssResponseStrategy } from "./hss-response-strategy.js";

export const HSS_EPISTEMIC_MARKER = "[HSS · epistemic]";

/** Removes the service footer from the response text (for UI and history).*/
export function stripHssEpistemicFooter(content: string): string {
  if (!content || !content.includes(HSS_EPISTEMIC_MARKER)) return content;
  return content
    .replace(/(?:\r?\n){0,2}\[HSS · epistemic\][^\n]*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

export function shouldAppendHssEpistemicHint(
  status: HssCoherenceStatus,
  responseStrategy: HssResponseStrategy
): boolean {
  if (responseStrategy === "clarification" || responseStrategy === "violation") return false;
  return status === "FRAGMENTED" || status === "CRITICAL";
}

export function buildHssEpistemicHintFooter(
  status: "FRAGMENTED" | "CRITICAL",
  entropyDelta: number
): string {
  const deltaStr = entropyDelta.toFixed(4);
  if (status === "CRITICAL") {
    return `${HSS_EPISTEMIC_MARKER} High growth of semantic entropy (ΔS≈${deltaStr}). The content of the answer may be controversial, unverified or fictitious - check the facts from the dialogue and external sources.`;
  }
  return `${HSS_EPISTEMIC_MARKER} An increase in semantic entropy was recorded (ΔS≈${deltaStr}). Certain statements may be controversial or unverified.`;
}

export function appendHssEpistemicHintIfNeeded(
  content: string,
  status: HssCoherenceStatus,
  responseStrategy: HssResponseStrategy,
  entropyDelta: number
): { content: string; appended: boolean; footer?: string } {
  if (!content.trim()) return { content, appended: false };
  if (!shouldAppendHssEpistemicHint(status, responseStrategy)) {
    return { content, appended: false };
  }
  if (content.includes(HSS_EPISTEMIC_MARKER)) {
    return { content, appended: false };
  }
  const footer = buildHssEpistemicHintFooter(status as "FRAGMENTED" | "CRITICAL", entropyDelta);
  return { content: `${content.trimEnd()}\n\n${footer}`, appended: true, footer };
}
