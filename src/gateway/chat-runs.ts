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
 * Ceiling on simultaneously running turns (`gateway.maxConcurrentChatRuns`,
 * default 8, 0 = off). Each running turn burns model tokens; unbounded
 * parallelism turns a reachable port into a money/DoS faucet. Newest-per-session
 * still wins (see beginChatRun), and sessions beyond this limit get a 429.
 */
export const DEFAULT_MAX_CONCURRENT_CHAT_RUNS = 8;

/** SSE keepalive interval of a chat stream (`gateway.chatKeepaliveMs`, 0 = off). */
export const DEFAULT_CHAT_KEEPALIVE_MS = 15_000;

/** Wall-clock cap of one turn (`gateway.chatRunMaxMs`, 0 = off): a stuck turn must not hold its slot forever. */
export const DEFAULT_CHAT_RUN_MAX_MS = 30 * 60_000;

/**
 * How long a new turn waits for the one it superseded to be stored
 * (`gateway.chatRunSettleWaitMs`). Past it the new turn starts without that
 * turn in its history.
 */
export const DEFAULT_CHAT_RUN_SETTLE_WAIT_MS = 15_000;

/** How long SIGTERM/SIGINT waits for the running turns to store themselves (`gateway.shutdownGraceMs`). */
export const DEFAULT_SHUTDOWN_GRACE_MS = 8_000;

/**
 * The reason a turn is aborted with when the gateway stops. Its terminal
 * frame and its stored answer say so (`gateway_restart`): a restart is not
 * to read as if the user had pressed Stop.
 */
export const SHUTDOWN_ABORT_REASON = "Gateway is shutting down";

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
  /**
   * Why the turn ended without its answer: `chat_cancelled` (stopped,
   * superseded or out of time), `gateway_restart` (the gateway was stopping),
   * or the reason its setup failed (`llm_not_configured`, …).
   */
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

/** A page the turn waits for: `readBrowserPage` reads the page the client shows, `headlessPageText` loads `url`. */
export interface ChatPageRequest {
  requestId: string;
  url?: string;
}

export interface ChatRun {
  readonly sessionId: string;
  /** Who started the turn; cancel and attach check it. */
  readonly userId: string;
  readonly controller: AbortController;
  readonly startedAt: number;
  /** Text streamed so far — what a returning client catches up on. */
  partialContent: string;
  /** The user message of the turn, shown to a client that attaches later (it is stored only when the turn ends). */
  readonly userMessage: string;
  sidebarUpdated: boolean;
  /** Tool steps in order; a step whose latest event is `start` is still running. */
  readonly steps: ToolStepEvent[];
  /** Page-text requests of the turn, in order; a client that attaches later is asked again for those still pending. */
  readonly pageRequests: ChatPageRequest[];
  /**
   * The last page the turn opened while no client was listening; the client
   * that attaches next gets it instead. A page a client already saw is never
   * repeated: what it opened survives a reload.
   */
  missedOpenUrl?: string;
  /** The turn that superseded this one. */
  successor?: ChatRun;
  /** The turn is stored in the chats database. */
  stored?: boolean;
  readonly listeners: Set<ChatRunListener>;
  terminal?: ChatRunTerminal;
  /** Resolves when the turn has settled, persistence included. */
  readonly done: Promise<void>;
}

const runs = new Map<string, ChatRun>();
const finishers = new Map<ChatRun, () => void>();
let shuttingDown = false;

/**
 * Registers a new turn for the session. A turn already running for the same
 * session is aborted (superseded) and returned as `previous`, so the caller
 * can wait for it to be stored before building the new turn's history.
 * The turn carries its question from the moment it is registered: a client
 * that attaches right after sees it.
 * Returns null when the gateway is stopping or when `maxConcurrent` turns
 * are running already (0 = no ceiling).
 */
export function beginChatRun(
  sessionId: string,
  userId: string,
  userMessage: string,
  maxConcurrent = DEFAULT_MAX_CONCURRENT_CHAT_RUNS
): { run: ChatRun; previous: ChatRun | null } | null {
  if (shuttingDown) return null;
  const old = runs.get(sessionId);
  let previous: ChatRun | null = null;
  if (old) {
    // Same-session rerun supersedes the older one and does not add load.
    old.controller.abort("Superseded by a newer chat request");
    previous = old;
  } else if (maxConcurrent > 0 && runs.size >= maxConcurrent) {
    return null;
  }
  let settle!: () => void;
  const run: ChatRun = {
    sessionId,
    userId,
    userMessage,
    controller: new AbortController(),
    startedAt: Date.now(),
    partialContent: "",
    sidebarUpdated: false,
    steps: [],
    pageRequests: [],
    listeners: new Set(),
    done: new Promise<void>((resolve) => {
      settle = resolve;
    }),
  };
  finishers.set(run, settle);
  if (old) old.successor = run;
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
  } else if ("readBrowserPage" in event) {
    run.pageRequests.push({ requestId: event.readBrowserPage.requestId });
  } else if ("headlessPageText" in event) {
    run.pageRequests.push({ requestId: event.headlessPageText.requestId, url: event.headlessPageText.url });
  } else if ("openBrowserUrl" in event && run.listeners.size === 0) {
    run.missedOpenUrl = event.openBrowserUrl;
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

/** Notes that the turn is in the chats database. */
export function markChatRunStored(run: ChatRun): void {
  run.stored = true;
}

/**
 * Whether a later turn of the same chat is stored already. A superseded turn
 * that stops late must then not be stored at all: it would follow the newer
 * turn in the history and read as the chat's latest exchange.
 */
export function hasStoredSuccessor(run: ChatRun): boolean {
  for (let next = run.successor; next; next = next.successor) {
    if (next.stored) return true;
  }
  return false;
}

/** Waits for a turn to settle, but never longer than `ms`. Resolves false when the turn is still unsettled. */
export function waitForChatRun(run: ChatRun, ms: number): Promise<boolean> {
  return Promise.race([
    run.done.then(() => true),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      timer.unref();
    }),
  ]);
}

/** True once the gateway started to stop: no new turn may begin. */
export function isChatShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Stops every running turn the way Stop does — each one stores its message,
 * the text printed so far and its tool steps — and waits for them to settle.
 * Returns the turns that did not settle in time.
 */
export async function stopChatRunsForShutdown(reason: string, ms: number): Promise<ChatRun[]> {
  shuttingDown = true;
  // A superseded turn has left the registry but is still storing itself.
  const live = [...finishers.keys()];
  for (const run of live) run.controller.abort(reason);
  const settled = await Promise.all(live.map((run) => waitForChatRun(run, ms)));
  return live.filter((_, index) => !settled[index]);
}

/** Empties the registry. Tests only: it is module state, so a test would otherwise inherit the turns of the one before. */
export function resetChatRunsForTest(): void {
  runs.clear();
  finishers.clear();
  shuttingDown = false;
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
