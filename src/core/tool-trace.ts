// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Tool trace: what the agent loop did with the tools in one turn. One record
 * feeds three consumers — live events for the UI (`onToolEvent`), the trace
 * returned in `result.tools` for storage, and the block later turns receive
 * in their history so the model knows what was already tried.
 */

import { clipHeadTail } from "./tool-budget.js";

/** Stored arguments: JSON as the model sent it, clipped. */
export const TOOL_TRACE_ARGS_MAX_CHARS = 2_000;
/** Stored result (the user's choice: results are kept, clipped). */
export const TOOL_TRACE_RESULT_MAX_CHARS = 4_000;
/** Result characters shown per step in the history block. */
const TOOL_TRACE_PREVIEW_CHARS = 240;
/** Total budget of trace blocks added to one prompt. */
export const TOOL_TRACE_HISTORY_MAX_CHARS = 6_000;
/** How many recent assistant turns get their trace block back. */
export const DEFAULT_TOOL_TRACE_HISTORY_TURNS = 3;

/** Tools whose result must never be stored or re-emitted. */
const NEVER_STORED_RESULTS = new Set(["read_secret"]);

/**
 * Tools whose successful result is external data (web, search, skill output,
 * the LLM room). The dispatcher arms the trifecta for the same set.
 */
const UNTRUSTED_RESULT_TOOLS = new Set(["search", "web_fetch", "read_browser_page", "run_agent", "room_history"]);

export interface ToolTraceEntry {
  /** 0-based order within the turn. */
  seq: number;
  /** 0-based loop iteration that issued the call. */
  iteration: number;
  name: string;
  /** JSON arguments as the model sent them, clipped. */
  args: string;
  /** Clipped result; "[redacted]" for secrets. Absent while the call is still running. */
  result?: string;
  ok?: boolean;
  durationMs?: number;
  /** The result is external content. It is stored, but never repeated to the model on later turns. */
  untrusted?: boolean;
}

export type ToolEvent =
  | { type: "start"; seq: number; iteration: number; name: string; args: string }
  | {
      type: "end";
      seq: number;
      iteration: number;
      name: string;
      args: string;
      /** Stored (clipped, redacted) result — not the full tool message. */
      result: string;
      ok: boolean;
      durationMs: number;
      untrusted: boolean;
      /** The model saw a clipped version of the result. */
      clipped: boolean;
    };

/** Secrets never leave the turn: not into the trace, not into an event. */
export function redactToolResult(name: string, result: string): string {
  return NEVER_STORED_RESULTS.has(name) ? "[redacted]" : result;
}

export function isUntrustedResultTool(name: string): boolean {
  return UNTRUSTED_RESULT_TOOLS.has(name);
}

/**
 * Whether a tool result reports a failure. Handlers return failures as text
 * ("Error: …", "<tool> failed: …"); a skill run fails through its exit code.
 */
export function toolResultLooksLikeError(content: string): boolean {
  const head = content.slice(0, 200);
  if (/^Error:/.test(head)) return true;
  if (/^[A-Za-z_]+ failed:/.test(head)) return true;
  const exitCode = /exitCode: (-?\d+)\n<<<\/EXT>>>\s*$/.exec(content);
  if (exitCode) return Number(exitCode[1]) !== 0;
  return false;
}

/** JSON arguments clipped for storage; unreadable input degrades to a string. */
export function argsForTrace(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args ?? {}) ?? "{}";
  } catch {
    text = String(args);
  }
  return clipHeadTail(text, TOOL_TRACE_ARGS_MAX_CHARS).text;
}

function formatDuration(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

function preview(result: string): string {
  const flat = result.replace(/\s+/g, " ").trim();
  return flat.length > TOOL_TRACE_PREVIEW_CHARS ? `${flat.slice(0, TOOL_TRACE_PREVIEW_CHARS)}…` : flat;
}

const UNTRUSTED_NOTE = "(external content, not repeated here — call the tool again if you need it)";
const INTERRUPTED_NOTE = "(interrupted — no result)";

function traceLine(entry: ToolTraceEntry, index: number): string {
  const status = entry.ok === false ? "error" : "ok";
  const duration = entry.durationMs != null ? ` (${formatDuration(entry.durationMs)})` : "";
  const result =
    entry.result == null
      ? INTERRUPTED_NOTE
      : entry.untrusted
        ? UNTRUSTED_NOTE
        : preview(entry.result) || "(empty result)";
  return `${index + 1}. ${entry.name} ${entry.args || "{}"} → ${status}${duration}\n   result: ${result}`;
}

/** Steps left out of a trace block that are still named at its top. */
const OMITTED_STEP_NAMES = 30;

/** `read a.txt`: the tool and the first text argument it was given — enough to tell the steps apart. */
function stepLabel(entry: ToolTraceEntry): string {
  const argument = /:\s*"((?:[^"\\]|\\.)*)"/.exec(entry.args)?.[1];
  return argument ? `${entry.name} ${argument.length > 60 ? `${argument.slice(0, 60)}…` : argument}` : entry.name;
}

/**
 * The block the model sees in the history instead of the raw tool messages.
 * `omitted` are the steps left out for size: they are still named, so the
 * model can tell what it no longer sees and repeat one if it needs it.
 */
export function formatToolTraceForHistory(
  entries: ToolTraceEntry[],
  omitted: readonly ToolTraceEntry[] = []
): string {
  const named = omitted.slice(-OMITTED_STEP_NAMES);
  const count = `${omitted.length} earlier step${omitted.length === 1 ? "" : "s"} left out for size`;
  const leftOut = named.length
    ? `${count}${named.length < omitted.length ? ` — the last ${named.length}` : ""}: ${named.map(stepLabel).join(", ")}\n`
    : "";
  // Numbered by their place in the turn, so the steps that stay keep their numbers.
  const lines = entries.map((entry, index) =>
    traceLine(entry, Number.isInteger(entry.seq) && entry.seq >= 0 ? entry.seq : index)
  );
  return `[Tool steps of this turn]\n${leftOut}${lines.join("\n")}`;
}

/**
 * Rebuilds the trace from the live events of a turn — for a turn that was
 * cut short (stopped, superseded) and so never returned `result.tools`.
 */
export function foldToolEvents(events: readonly ToolEvent[]): ToolTraceEntry[] {
  const bySeq = new Map<number, ToolTraceEntry>();
  for (const event of events) {
    if (event.type === "start") {
      if (!bySeq.has(event.seq)) {
        bySeq.set(event.seq, { seq: event.seq, iteration: event.iteration, name: event.name, args: event.args });
      }
      continue;
    }
    bySeq.set(event.seq, {
      seq: event.seq,
      iteration: event.iteration,
      name: event.name,
      args: event.args,
      result: event.result,
      ok: event.ok,
      durationMs: event.durationMs,
      untrusted: event.untrusted,
    });
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export interface TraceHistoryMessage {
  role: "user" | "assistant";
  content: string;
  tools?: ToolTraceEntry[];
}

/**
 * Appends a trace block to the newest assistant turns that ran tools. Turns
 * beyond `maxTurns` get nothing; a block that would exceed `maxChars` loses
 * its oldest steps, which it names in its first line. Input messages are not
 * modified.
 */
export function withToolTraceHistory<T extends TraceHistoryMessage>(
  history: T[],
  maxTurns: number = DEFAULT_TOOL_TRACE_HISTORY_TURNS,
  maxChars: number = TOOL_TRACE_HISTORY_MAX_CHARS
): T[] {
  if (maxTurns <= 0 || maxChars <= 0) return history;
  const out = [...history];
  let budget = maxChars;
  let turnsLeft = maxTurns;
  for (let i = out.length - 1; i >= 0 && turnsLeft > 0 && budget > 0; i--) {
    const msg = out[i];
    if (!msg || msg.role !== "assistant" || !msg.tools?.length) continue;
    turnsLeft--;
    const all = msg.tools;
    let entries = all;
    let block = formatToolTraceForHistory(entries);
    while (block.length > budget && entries.length > 1) {
      entries = entries.slice(1);
      block = formatToolTraceForHistory(entries, all.slice(0, all.length - entries.length));
    }
    if (block.length > budget) continue;
    budget -= block.length;
    out[i] = { ...msg, content: `${msg.content}\n\n${block}` };
  }
  return out;
}
