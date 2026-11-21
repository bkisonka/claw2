// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Strip HSS / Recap / EXT scaffolding that models sometimes dump into chat replies.
 */

import { unwrapExtContent } from "./session-export.js";

const LEAK_BLOCK_START =
  /^(?:\[(?:User'?s\s+)?HSS[^\]]*\]|\[HSS[^\]]*\]|\[Recap[^\]]*\]|\[Internal dialogue recap[^\]]*\])/im;

/** Lines that look like chronicle recall dumps. */
const CHRONICLE_HIT_LINE =
  /^\s*\[\d+\]\s*\(importance=\d/i;

const ACTION_PLAN_LINE = /^\s*Действие:\s*/i;
const ACTION_PLAN_LINE_EN = /^\s*Action:\s*(?:Reply to the user|Respond to the user|Answer the user)/i;

/**
 * Plain text for chronicle / prompt injection: drop <<<EXT>>> wrappers.
 */
export function sanitizeForChroniclePrompt(text: string): string {
  const unwrapped = unwrapExtContent(text ?? "");
  return unwrapped
    .replace(/<<<EXT>>>|<<<\/EXT>>>/gi, "")
    .replace(/<<>>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isMetaLine(t: string): boolean {
  if (!t) return false;
  return (
    LEAK_BLOCK_START.test(t) ||
    CHRONICLE_HIT_LINE.test(t) ||
    /^Source:\s*/i.test(t) ||
    ACTION_PLAN_LINE.test(t) ||
    ACTION_PLAN_LINE_EN.test(t) ||
    /^important to recall/i.test(t) ||
    /^Relevant fragments/i.test(t) ||
    /^Резюме диалога/i.test(t) ||
    /importance=\d|source=auto|sim=\d/i.test(t)
  );
}

/**
 * Remove leaked internal prompt blocks from an assistant reply.
 * Conservative: only strips when the reply clearly starts with meta scaffolding.
 */
export function stripInternalPromptLeak(reply: string): string {
  const raw = reply ?? "";
  if (!raw.trim()) return raw;

  const lines = raw.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !lines[i]!.trim()) i++;
  if (i >= lines.length) return raw;

  const head = lines[i]!.trim();
  const looksLikeLeakHeader = LEAK_BLOCK_START.test(head) || CHRONICLE_HIT_LINE.test(head);
  if (!looksLikeLeakHeader) {
    const cleaned = lines
      .filter((ln) => !ACTION_PLAN_LINE.test(ln) && !ACTION_PLAN_LINE_EN.test(ln))
      .join("\n")
      .trim();
    return cleaned || raw.trim();
  }

  let j = i;
  let inRecapBody = false;
  while (j < lines.length) {
    const t = lines[j]!.trim();
    if (!t) {
      j++;
      if (inRecapBody) {
        // blank after recap/action → real reply may follow
        while (j < lines.length && !lines[j]!.trim()) j++;
        break;
      }
      continue;
    }
    if (/^\[Recap/i.test(t) || /^Резюме диалога/i.test(t)) {
      inRecapBody = true;
      j++;
      continue;
    }
    if (ACTION_PLAN_LINE.test(t) || ACTION_PLAN_LINE_EN.test(t)) {
      inRecapBody = true;
      j++;
      continue;
    }
    if (isMetaLine(t) || inRecapBody) {
      j++;
      continue;
    }
    // First non-meta line outside recap → start of real answer
    break;
  }

  const rest = lines.slice(j).join("\n").trim();
  if (rest) return rest;
  return "";
}
