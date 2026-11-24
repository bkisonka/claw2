// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Context budget for tool results inside one chat turn. Without it a single
 * large result (a 512 KB file, 256 KB of skill stdout) or a long chain of
 * them overflows the model's context window and the whole turn fails.
 *
 * Two limits:
 *   - every result is clipped to `toolResultMaxChars` before the model sees it;
 *   - before each model call, older results are compacted down to a short head
 *     while the sum of all results is above `toolContextMaxChars`.
 */

import type OpenAI from "openai";

export const DEFAULT_TOOL_RESULT_MAX_CHARS = 24_000;
export const DEFAULT_TOOL_CONTEXT_MAX_CHARS = 160_000;
/** An older result compacted to free budget keeps this many leading characters. */
export const TOOL_COMPACT_HEAD_CHARS = 1_200;

const COMPACTED_PREFIX = "[compacted tool result";
/** Share of the kept budget that goes to the head of a clipped result. */
const HEAD_SHARE = 0.7;

export interface ClippedToolResult {
  content: string;
  clipped: boolean;
  originalChars: number;
}

/** Keeps the head and the tail of `text`; the middle is dropped. */
export function clipHeadTail(text: string, maxChars: number): { text: string; clipped: boolean } {
  if (text.length <= maxChars) return { text, clipped: false };
  if (maxChars <= 0) return { text: "", clipped: true };
  const head = Math.ceil(maxChars * HEAD_SHARE);
  const tail = Math.max(0, maxChars - head);
  return {
    text: tail > 0 ? `${text.slice(0, head)}${text.slice(-tail)}` : text.slice(0, head),
    clipped: true,
  };
}

function clipMarker(omitted: number, total: number): string {
  return (
    `\n\n[… tool result clipped: ${omitted.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} characters omitted. ` +
    "For a file, read(path, offset, limit) returns the missing lines; otherwise narrow the request " +
    "or have the skill write the full output to a file. …]\n\n"
  );
}

/** Clips one tool result, leaving a marker that tells the model how to get the rest. */
export function clipToolResult(content: string, maxChars: number): ClippedToolResult {
  const total = content.length;
  if (total <= maxChars) return { content, clipped: false, originalChars: total };
  const marker = clipMarker(total - maxChars, total);
  const keep = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(keep * HEAD_SHARE);
  const tail = Math.max(0, keep - head);
  const headPart = content.slice(0, head);
  const tailPart = tail > 0 ? content.slice(content.length - tail) : "";
  return { content: `${headPart}${marker}${tailPart}`, clipped: true, originalChars: total };
}

export interface ToolCallMeta {
  name: string;
  args: string;
}

export interface CompactLimits {
  maxTotalChars: number;
  headChars?: number;
}

function compactedResult(meta: ToolCallMeta | undefined, content: string, headChars: number): string {
  const label = meta ? `${meta.name} ${meta.args || "{}"}` : "tool";
  const omitted = Math.max(0, content.length - headChars);
  return (
    `[compacted tool result: ${label} — ${omitted.toLocaleString("en-US")} characters omitted to stay inside the ` +
    "context budget; call the tool again if you need the full output — for a file, read(path, offset, limit) returns " +
    `the missing lines.]\n${content.slice(0, headChars)}`
  );
}

/**
 * Compacts the oldest tool results in `messages` (in place) until their total
 * fits `limits.maxTotalChars`. Results whose call id is in `protectedCallIds`
 * (the iteration the model is answering right now) and results already
 * compacted are left alone. Returns how many results were compacted.
 */
export function compactToolResults(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  callMeta: ReadonlyMap<string, ToolCallMeta>,
  protectedCallIds: ReadonlySet<string>,
  limits: CompactLimits
): number {
  let total = 0;
  for (const m of messages) if (m.role === "tool") total += String(m.content).length;
  if (total <= limits.maxTotalChars) return 0;

  let compacted = 0;
  for (const m of messages) {
    if (total <= limits.maxTotalChars) break;
    if (m.role !== "tool") continue;
    const content = String(m.content);
    // A result no longer than the kept head has nothing to give up, and a
    // replacement must always be shorter than what it replaces.
    if (protectedCallIds.has(m.tool_call_id) || content.startsWith(COMPACTED_PREFIX)) continue;
    const headChars = limits.headChars ?? TOOL_COMPACT_HEAD_CHARS;
    if (content.length <= headChars) continue;
    const next = compactedResult(callMeta.get(m.tool_call_id), content, headChars);
    if (next.length >= content.length) continue;
    total += next.length - content.length;
    m.content = next;
    compacted++;
  }
  return compacted;
}
