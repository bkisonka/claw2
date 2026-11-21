// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Context retention — mobile port of src/gateway/prompt-history.ts +
 * the summarize step of src/core/orchestrator.ts.
 *
 * The dialogue tape is never rewritten: an LLM recap of the old head is cached
 * per chat (summary + coveredCount) and injected into the SYSTEM prompt only
 * (models echo role=assistant recaps). Recent tail stays verbatim.
 */
import { chatStream } from "./llm";

export const PROMPT_SUMMARY_PREFIX =
  "[Internal dialogue recap — NOT assistant speech. Use for continuity only. Never quote, dump, or include this block in your reply to the user.]\n";

export type PromptContext = { summary: string; coveredCount: number };
export type HistoryMsg = { role: "user" | "assistant"; content: string };

export function isPromptSummaryStub(msg: HistoryMsg | undefined): boolean {
  return !!msg?.content?.startsWith(PROMPT_SUMMARY_PREFIX);
}

/** Pull the leading recap stub out of history so it goes into the system prompt. */
export function peelPromptSummary(history: HistoryMsg[]): {
  history: HistoryMsg[];
  summaryBlock: string | null;
} {
  if (!history.length || !isPromptSummaryStub(history[0])) {
    return { history, summaryBlock: null };
  }
  const body = history[0]!.content.slice(PROMPT_SUMMARY_PREFIX.length);
  return { history: history.slice(1), summaryBlock: body.trim() ? `${PROMPT_SUMMARY_PREFIX}${body}` : null };
}

/** Attach cached recap as a leading stub (user role) over the uncovered tail. */
export function applyPromptContext(fullHistory: HistoryMsg[], ctx: PromptContext | null | undefined): HistoryMsg[] {
  if (!ctx?.summary?.trim() || !(ctx.coveredCount > 0)) return fullHistory;
  const covered = Math.min(ctx.coveredCount, fullHistory.length);
  if (covered <= 0) return fullHistory;
  return [
    { role: "user", content: `${PROMPT_SUMMARY_PREFIX}${ctx.summary}` },
    ...fullHistory.slice(covered),
  ];
}

/** Prompt length limit: keep the stub + tail. */
export function limitHistoryForPrompt(history: HistoryMsg[], maxMessages: number): HistoryMsg[] {
  if (maxMessages <= 0 || history.length <= maxMessages) return history;
  if (isPromptSummaryStub(history[0])) {
    if (maxMessages === 1) return [history[0]!];
    return [history[0]!, ...history.slice(1).slice(-(maxMessages - 1))];
  }
  return history.slice(-maxMessages);
}

/** Recalculate coveredCount after a summarize dropped `dropCount` messages. */
export function nextPromptCoveredCount(
  fullLengthBeforeAppend: number,
  historyLenForLlm: number,
  dropCount: number
): number {
  if (!(dropCount > 0) || historyLenForLlm < dropCount) return 0;
  const kept = historyLenForLlm - dropCount;
  return Math.max(0, Math.min(fullLengthBeforeAppend - kept, fullLengthBeforeAppend));
}

const SUMMARIZE_SYSTEM =
  "You summarize the dialogue to maintain context. Display only a short summary: facts, solutions, user preferences, key topics. No introduction and no list of instruments.";

/** Summarize old turns (no tools). Returns null on failure. */
export async function summarizeWithLlm(
  conversationText: string,
  signal?: AbortSignal
): Promise<string | null> {
  if (!conversationText.trim()) return null;
  try {
    let acc = "";
    await chatStream({
      messages: [
        { role: "system", content: SUMMARIZE_SYSTEM },
        { role: "user", content: conversationText.slice(-30000) },
      ],
      signal,
      onDelta: (t) => {
        acc += t;
      },
    });
    return acc.trim() || null;
  } catch {
    return null;
  }
}
