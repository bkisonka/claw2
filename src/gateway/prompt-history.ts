// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Build history for the LLM prompt separately from the full UI chat feed.
 * The summary is cached (prompt_summary/sessions map); messages are not overwritten.
 *
 * Recap must NOT be injected as role=assistant (models echo it). Prefer system addendum.
 */

export const PROMPT_SUMMARY_PREFIX =
  "[Internal dialogue recap — NOT assistant speech. Use for continuity only. Never quote, dump, or include this block in your reply to the user.]\n";

/** Older stub prefix (still recognized when peeling history). */
export const PROMPT_SUMMARY_PREFIX_LEGACY = "[Recap of previous dialogue]\n";

export interface PromptContext {
  summary: string;
  /** How many of the first messages of the full feed are covered by the summary.*/
  coveredCount: number;
}

export type HistoryMsg = { role: "user" | "assistant"; content: string };

function summaryBodyFromStub(content: string): string | null {
  if (content.startsWith(PROMPT_SUMMARY_PREFIX)) {
    return content.slice(PROMPT_SUMMARY_PREFIX.length);
  }
  if (content.startsWith(PROMPT_SUMMARY_PREFIX_LEGACY)) {
    return content.slice(PROMPT_SUMMARY_PREFIX_LEGACY.length);
  }
  return null;
}

export function isPromptSummaryStub(msg: HistoryMsg | undefined): boolean {
  if (!msg?.content) return false;
  return summaryBodyFromStub(msg.content) != null;
}

/**
 * Pull a leading recap stub out of history so it can go into the system prompt
 * instead of remaining as a fake user/assistant turn.
 */
export function peelPromptSummary(history: HistoryMsg[]): {
  history: HistoryMsg[];
  summaryBlock: string | null;
} {
  if (!history.length || !isPromptSummaryStub(history[0])) {
    return { history, summaryBlock: null };
  }
  const body = summaryBodyFromStub(history[0]!.content) ?? "";
  return {
    history: history.slice(1),
    summaryBlock: body.trim() ? `${PROMPT_SUMMARY_PREFIX}${body}` : null,
  };
}

/**
 * Attach cached summary as a peelable leading stub (user role — never assistant).
 * Orchestrator must call peelPromptSummary and move it into the system prompt.
 */
export function applyPromptContext(fullHistory: HistoryMsg[], ctx: PromptContext | null | undefined): HistoryMsg[] {
  if (!ctx?.summary?.trim() || !(ctx.coveredCount > 0)) return fullHistory;
  const covered = Math.min(ctx.coveredCount, fullHistory.length);
  if (covered <= 0) return fullHistory;
  return [
    { role: "user", content: `${PROMPT_SUMMARY_PREFIX}${ctx.summary}` },
    ...fullHistory.slice(covered),
  ];
}

/**
 * Length limit for prompt: save stub summary (if any) + tail.
 */
export function limitHistoryForPrompt(history: HistoryMsg[], maxMessages: number): HistoryMsg[] {
  if (maxMessages <= 0 || history.length <= maxMessages) return history;
  if (isPromptSummaryStub(history[0])) {
    if (maxMessages === 1) return [history[0]!];
    return [history[0]!, ...history.slice(1).slice(-(maxMessages - 1))];
  }
  return history.slice(-maxMessages);
}

/**
 * Recalculate the coveredCount of the full tape after the orchestrator summarizes.
 * kept = how many messages from the transferred sessionHistory remain after drop;
 * they are the tail of the full UI ribbon → covered = fullLen - kept.
 */
export function nextPromptCoveredCount(
  fullLengthBeforeAppend: number,
  historyLenForLlm: number,
  dropCount: number
): number {
  if (!(dropCount > 0) || historyLenForLlm < dropCount) {
    return 0;
  }
  const kept = historyLenForLlm - dropCount;
  return Math.max(0, Math.min(fullLengthBeforeAppend - kept, fullLengthBeforeAppend));
}
