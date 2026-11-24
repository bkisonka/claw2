// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Registry of running chat turns. A turn ("run") outlives the HTTP request
 * that started it: the request is only one of its subscribers. That is what
 * lets a long agent turn survive a closed tab or a dropped connection, lets
 * the web client re-attach and catch up, and makes "stop" an explicit call
 * instead of "disconnect".
 */

import type { ServerResponse } from "node:http";
import { clipHeadTail } from "../core/tool-budget.js";
import type { ToolEvent } from "../core/tool-trace.js";

/**
 * Ceiling on simultaneously running turns. Each running turn burns model
 * tokens; unbounded parallelism turns a reachable port into a money/DoS
 * faucet. Newest-per-session still wins (see beginChatRun), and sessions
 * beyond this limit get a 429.
 */
export const MAX_CONCURRENT_CHAT_RUNS = 8;

/** SSE keepalive interval of a chat stream (`gateway.chatKeepaliveMs`, 0 = off). */
export const DEFAULT_CHAT_KEEPALIVE_MS = 15_000;

/** Wall-clock cap of one turn (`gateway.chatRunMaxMs`, 0 = off): a stuck turn must not hold its slot forever. */
export const DEFAULT_CHAT_RUN_MAX_MS = 30 * 60_000;

/** How long a new turn waits for the one it superseded to be stored. */
export const RUN_SETTLE_WAIT_MS = 15_000;

/** Characters of a tool call's arguments shown in the UI. */
export const TOOL_STEP_ARGS_CHARS = 200;

export interface ChatCell {
  type: string;
  content: string;
}

/** Tool step as the UI sees it — the result text stays on the server. */
export interface ToolStepEvent {
  type: "start" | "end";
  seq: number;
  iteration: number;
  name: string;
  /** Clipped argument summary. */
  args: string;
  ok?: boolean;
  durationMs?: number;
  clipped?: boolean;
}

export type ChatRunEvent =
  | { content: string }
  | { sidebarUpdated: true }
  | { openBrowserUrl: string }
  | { readBrowserPage: { requestId: string } }
  | { headlessPageText: { requestId: string; url: string } }
  | { toolEvent: ToolStepEvent };

/** The last frame of a stream: the turn is over and stored. */
export interface ChatRunTerminal {
  content?: string;
  error?: string;
  code?: string;
  lastRunId?: number;
  cells?: ChatCell[];
  userCells?: ChatCell[];
  contextCompressed?: number;
  sidebarUpdated?: boolean;
  toolLimitReached?: boolean;
  insightOffer?: unknown;
  /** Nothing was running: the client reloads the stored history instead. */
  noRun?: boolean;
}

export type ChatRunListener = (event: ChatRunEvent | { terminal: ChatRunTerminal }) => void;

export interface ChatRun {
  readonly sessionId: string;
  /** Who started the turn; cancel and attach check it. */
  readonly userId: string;
  readonly controller: AbortController;
  readonly startedAt: number;
  /** Text streamed so far — what a returning client catches up on. */
  partialContent: string;
  /** The user message of the turn, shown to a client that attaches later (it is stored only when the turn ends). */
  userMessage?: string;
  sidebarUpdated: boolean;
  /** Tool steps in order; a step whose latest event is `start` is still running. */
  readonly steps: ToolStepEvent[];
  readonly listeners: Set<ChatRunListener>;
  terminal?: ChatRunTerminal;
  /** Resolves when the turn has settled, persistence included. */
  readonly done: Promise<void>;
}

const runs = new Map<string, ChatRun>();
const finishers = new Map<ChatRun, () => void>();

/**
 * Registers a new turn for the session. A turn already running for the same
 * session is aborted (superseded) and returned as `previous`, so the caller
 * can wait for it to be stored before building the new turn's history.
 * Returns null when the global limit is reached.
 */
export function beginChatRun(
  sessionId: string,
  userId: string
): { run: ChatRun; previous: ChatRun | null } | null {
  const old = runs.get(sessionId);
  let previous: ChatRun | null = null;
  if (old) {
    // Same-session rerun supersedes the older one and does not add load.
    old.controller.abort("Superseded by a newer chat request");
    previous = old;
  } else if (runs.size >= MAX_CONCURRENT_CHAT_RUNS) {
    return null;
  }
  let settle!: () => void;
  const run: ChatRun = {
    sessionId,
    userId,
    controller: new AbortController(),
    startedAt: Date.now(),
    partialContent: "",
    sidebarUpdated: false,
    steps: [],
    listeners: new Set(),
    done: new Promise<void>((resolve) => {
      settle = resolve;
    }),
  };
  finishers.set(run, settle);
  runs.set(sessionId, run);
  return { run, previous };
}

/** Fans an event out to the subscribers and folds it into the run's catch-up state. */
export function publishChatRun(run: ChatRun, event: ChatRunEvent): void {
  if (run.terminal) return;
  if ("content" in event) {
    run.partialContent += event.content;
  } else if ("sidebarUpdated" in event) {
    run.sidebarUpdated = true;
  } else if ("toolEvent" in event) {
    const step = event.toolEvent;
    const index = run.steps.findIndex((s) => s.seq === step.seq);
    if (step.type === "end" && index >= 0) {
      run.steps[index] = { ...run.steps[index]!, ...step };
    } else if (index < 0) {
      run.steps.push(step);
    }
  }
  for (const listener of [...run.listeners]) {
    try {
      listener(event);
    } catch {
      // a broken subscriber must not break the turn
    }
  }
}

/** Delivers the terminal frame, releases the session slot and wakes whoever waits for the turn. */
export function finishChatRun(run: ChatRun, terminal: ChatRunTerminal): void {
  if (run.terminal) return;
  run.terminal = terminal;
  for (const listener of [...run.listeners]) {
    try {
      listener({ terminal });
    } catch {
      // a broken subscriber must not break the turn
    }
  }
  run.listeners.clear();
  if (runs.get(run.sessionId) === run) runs.delete(run.sessionId);
  finishers.get(run)?.();
  finishers.delete(run);
}

export function subscribeChatRun(run: ChatRun, listener: ChatRunListener): () => void {
  run.listeners.add(listener);
  return () => {
    run.listeners.delete(listener);
  };
}

export function getChatRun(sessionId: string): ChatRun | undefined {
  return runs.get(sessionId);
}

/** Asks the turn to stop. The turn's own executor does the rest (stores what was done, ends the streams). */
export function abortChatRun(sessionId: string, reason = "Chat cancelled"): ChatRun | undefined {
  const run = runs.get(sessionId);
  if (!run || run.terminal) return undefined;
  run.controller.abort(reason);
  return run;
}

export function hasActiveChatRun(sessionId: string): boolean {
  return runs.has(sessionId);
}

export function activeChatSessionIds(): string[] {
  return [...runs.keys()];
}

/** Waits for a turn to settle, but never longer than `ms`. */
export function waitForChatRun(run: ChatRun, ms: number): Promise<void> {
  return Promise.race([
    run.done,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
    }),
  ]);
}

/** Live tool event → what the UI gets: no result text, short arguments. */
export function toStepEvent(event: ToolEvent): ToolStepEvent {
  const base = {
    seq: event.seq,
    iteration: event.iteration,
    name: event.name,
    args: clipHeadTail(event.args, TOOL_STEP_ARGS_CHARS).text,
  };
  return event.type === "start"
    ? { type: "start", ...base }
    : { type: "end", ...base, ok: event.ok, durationMs: event.durationMs, clipped: event.clipped };
}

/** SSE comment frames so proxies and browsers do not drop an idle stream. Returns the stop function. */
export function startSseKeepalive(res: ServerResponse, intervalMs: number): () => void {
  if (!(intervalMs > 0)) return () => {};
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(timer);
      return;
    }
    res.write(": keepalive\n\n");
  }, intervalMs);
  return () => clearInterval(timer);
}
