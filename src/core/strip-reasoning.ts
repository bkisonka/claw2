// SPDX-License-Identifier: AGPL-3.0-only
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

/** Hold back a trailing partial prefix of an open tag ("<comm", "<comment"…) during streaming. */
function partialTagLength(buf: string, full: string): number {
  const lower = buf.toLowerCase();
  const tag = full.toLowerCase();
  for (let n = Math.min(buf.length, tag.length); n >= 1; n--) {
    const suffix = lower.slice(-n);
    if (tag.startsWith(suffix)) return n;
  }
  return 0;
}

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

/** An unterminated <comment> at the very end of the text: the model stopped mid-comment. */
function trailingCommentLength(buf: string): number {
  const open = buf.search(/<comment>/i);
  return open >= 0 ? buf.length - open : 0;
}

/**
 * Strip model chain-of-thought markers from assistant content.
 */
export function stripCommentTags(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/\s*<comment>[\s\S]*?<\/comment\s*>/gi, "")
    .replace(/\s*<comment>[\s\S]*$/i, "")
    .trim();
}

/** Pull the inner text of every <comment>…</comment> (and a trailing unterminated one) out of the text. */
export function extractCommentBlocks(text: string | null | undefined): {
  content: string;
  comments: string[];
} {
  const comments: string[] = [];
  if (!text) return { content: text ?? "", comments };
  const stripped = text.replace(/\s*<comment>[\s\S]*?<\/comment\s*>/gi, (block) => {
    const inner = block
      .trim()
      .replace(/^<comment>/i, "")
      .replace(/<\/comment\s*>$/i, "")
      .trim();
    if (inner) comments.push(inner);
    return "";
  });
  let content = stripped;
  const open = content.search(/<comment>/i);
  if (open >= 0) {
    const tail = content.slice(open + "<comment>".length).trim();
    if (tail) comments.push(tail);
    content = content.slice(0, open).replace(/\s+$/, "");
  }
  return { content, comments };
}

/**
 * Streaming filter for step commentary: <comment>…</comment> segments are
 * captured and handed to onComment for the progress UI, and are never
 * emitted as visible content.
 */
export function createCommentStreamFilter(onComment?: (text: string) => void): {
  push: (delta: string) => string;
  flush: () => string;
} {
  let buf = "";
  const push = (delta: string): string => {
    if (!delta) return "";
    buf += delta;
    let out = "";
    for (;;) {
      const closed = buf.match(/<comment>([\s\S]*?)<\/comment\s*>/i);
      if (closed?.index != null) {
        out += buf.slice(0, closed.index);
        const text = closed[1].trim();
        if (text) onComment?.(text);
        buf = buf.slice(closed.index + closed[0].length);
        continue;
      }
      const open = buf.search(/<comment>/i);
      if (open >= 0) {
        out += buf.slice(0, open);
        buf = buf.slice(open);
        return out;
      }
      const hold = partialTagLength(buf, "<comment>");
      if (hold > 0) {
        out += buf.slice(0, -hold);
        buf = buf.slice(-hold);
        return out;
      }
      out += buf;
      buf = "";
      return out;
    }
  };
  const flush = (): string => {
    const held = trailingCommentLength(buf);
    if (held > 0) {
      // An unterminated comment at the end of the stream is still a comment.
      const text = buf.slice(buf.length - held + "<comment>".length).trim();
      if (text) onComment?.(text);
      buf = buf.slice(0, buf.length - held);
    }
    const rest = buf;
    buf = "";
    return rest;
  };
  return { push, flush };
}

const EMOTION_OPEN_TAG = "<emotion>";

/**
 * Strip <emotion>…</emotion> markers from assistant content (batch version).
 * Mirrors stripCommentTags; the value is a short mood word, never rendered.
 */
export function stripEmotionTags(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/\s*<emotion>[^<]*<\/emotion\s*>/gi, "")
    .replace(/\s*<emotion>[^<]*$/i, "")
    .trim();
}

/** Pull the first <emotion>…</emotion> (and a trailing unterminated one) out of the text. */
export function extractEmotionTag(text: string | null | undefined): {
  content: string;
  emotion?: string;
} {
  if (!text) return { content: text ?? "" };
  let emotion: string | undefined;
  const stripped = text.replace(/\s*<emotion>([^<]*)<\/emotion\s*>/gi, (_block, inner: string) => {
    const value = inner.trim();
    if (value && emotion === undefined) emotion = value;
    return "";
  });
  let content = stripped;
  const open = content.search(/<emotion>/i);
  if (open >= 0) {
    const tail = content.slice(open + EMOTION_OPEN_TAG.length).trim();
    if (tail && emotion === undefined) emotion = tail;
    content = content.slice(0, open).replace(/\s+$/, "");
  }
  // The tag stands at the head of the answer: what follows it is the reply.
  return { content: content.replace(/^\s+/, ""), emotion };
}

/**
 * Streaming filter for the emotion overlay: the <emotion>…</emotion> tag is
 * captured, handed to onEmotion (first value wins) and never emitted as
 * visible content — the same contract as createCommentStreamFilter.
 */
export function createEmotionStreamFilter(onEmotion?: (value: string) => void): {
  push: (delta: string) => string;
  flush: () => string;
} {
  let buf = "";
  let seen = false;
  /** The tag stands at the head of the answer: the visible reply must not start with its leftover whitespace. */
  let started = false;
  const trimHead = (text: string): string => {
    if (started) return text;
    const trimmed = text.replace(/^\s+/, "");
    if (trimmed) started = true;
    return trimmed;
  };
  const push = (delta: string): string => {
    if (!delta) return "";
    buf += delta;
    let out = "";
    for (;;) {
      const closed = buf.match(/<emotion>([^<]*)<\/emotion\s*>/i);
      if (closed?.index != null) {
        out += buf.slice(0, closed.index);
        const value = closed[1].trim();
        if (value && !seen) {
          onEmotion?.(value);
          seen = true;
        }
        buf = buf.slice(closed.index + closed[0].length);
        continue;
      }
      const open = buf.search(/<emotion>/i);
      if (open >= 0) {
        out += buf.slice(0, open);
        buf = buf.slice(open);
        return trimHead(out);
      }
      const hold = partialTagLength(buf, EMOTION_OPEN_TAG);
      if (hold > 0) {
        out += buf.slice(0, -hold);
        buf = buf.slice(-hold);
        return trimHead(out);
      }
      out += buf;
      buf = "";
      return trimHead(out);
    }
  };
  const flush = (): string => {
    // An unterminated tag at the end of the stream is still an emotion.
    const open = buf.search(/<emotion>/i);
    if (open >= 0) {
      const value = buf.slice(open + EMOTION_OPEN_TAG.length).trim();
      if (value && !seen) onEmotion?.(value);
      buf = buf.slice(0, open);
    }
    const rest = trimHead(buf);
    buf = "";
    return rest;
  };
  return { push, flush };
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
