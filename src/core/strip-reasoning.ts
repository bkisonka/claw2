// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Strip model chain-of-thought markers from assistant content.
 * MiniMax-M3 uses <mm:think>…</mm:think> (often interleaved); plain <think> also appears.
 * Bad proxy stripping of interleaved blocks is a common cause of “first syllables eaten”.
 */

const OPEN_THINK_RE = /<(?:mm:)?think\b/i;

function stripClosedThinkBlocks(text: string): string {
  return text.replace(/\s*<(?:mm:)?think\b[^>]*>[\s\S]*?<\/(?:mm:)?think\s*>/gi, "");
}

/** Hold back a trailing partial open-tag prefix during streaming. */
function partialOpenTagLength(buf: string): number {
  const candidates = ["<mm:think", "<think", "<mm:", "<mm", "<m", "<t", "<th", "<thi", "<thin", "<think"];
  const lower = buf.toLowerCase();
  for (let n = Math.min(buf.length, 12); n >= 1; n--) {
    const suffix = lower.slice(-n);
    if (candidates.some((c) => c.startsWith(suffix) && suffix.length < c.length + 1)) {
      // Allow "<think" / "<mm:think" complete start without `>` still held
      if (suffix === "<think" || suffix === "<mm:think") return n;
      if (candidates.some((c) => c.startsWith(suffix))) return n;
    }
  }
  if (buf.endsWith("<")) return 1;
  return 0;
}

export function stripReasoningTags(text: string | null | undefined): string {
  if (!text || typeof text !== "string") return "";
  let s = stripClosedThinkBlocks(text);
  const open = s.search(OPEN_THINK_RE);
  if (open >= 0) s = s.slice(0, open);
  return s.replace(/^\s+/, "").replace(/\s+$/, "");
}

/**
 * Streaming filter: emit only visible text, hold incomplete <mm:think> / <think> blocks.
 */
export function createReasoningStreamFilter(): {
  push: (delta: string) => string;
  flush: () => string;
} {
  let buf = "";
  const push = (delta: string): string => {
    if (!delta) return "";
    buf += delta;
    buf = stripClosedThinkBlocks(buf);
    const open = buf.search(OPEN_THINK_RE);
    if (open >= 0) {
      const emit = buf.slice(0, open);
      buf = buf.slice(open);
      return emit;
    }
    const hold = partialOpenTagLength(buf);
    if (hold > 0) {
      const emit = buf.slice(0, -hold);
      buf = buf.slice(-hold);
      return emit;
    }
    const emit = buf;
    buf = "";
    return emit;
  };
  const flush = (): string => {
    const rest = stripReasoningTags(buf);
    buf = "";
    return rest;
  };
  return { push, flush };
}

/** MiniMax-M3 enables interleaved thinking unless explicitly disabled — that corrupts content. */
export function shouldDisableModelThinking(
  model: string | undefined,
  enableThinking: boolean | undefined
): boolean {
  if (enableThinking === true) return false;
  if (enableThinking === false) return true;
  return /minimax/i.test(model ?? "");
}
