// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Claw2Config } from "../config/types.js";
import type { OrchestratorOptions } from "../core/orchestrator.js";
import { runOrchestrator } from "../core/orchestrator.js";
import type { ToolTraceEntry } from "../core/tool-trace.js";
import { closeDb, initDb, type ChatRepository } from "./db/index.js";
import { resetChatRunsForTest } from "./chat-runs.js";
import { createGatewayServer } from "./server.js";
import { shutdownGateway } from "./shutdown.js";

vi.mock("../core/orchestrator.js", () => ({ runOrchestrator: vi.fn() }));

const configRef: { current: Claw2Config } = { current: {} };
const mockOrchestrator = vi.mocked(runOrchestrator);
let dir: string;
let dbPath: string;
let base: string;
let server: ReturnType<typeof createGatewayServer>;
let repo: ChatRepository;
let sessionSeq = 0;
/** Lets every hanging turn of a test finish before the next one starts. */
let releaseAll: Array<() => void> = [];

const STEP_ARGS = '{"path":"output/a.txt"}';
const trace: ToolTraceEntry[] = [
  { seq: 0, iteration: 0, name: "read", args: STEP_ARGS, result: "SECRET-RESULT-TEXT", ok: true, durationMs: 5, untrusted: false },
];

beforeEach(() => {
  mockOrchestrator.mockReset();
  releaseAll = [];
  dir = mkdtempSync(join(tmpdir(), "claw2-chat-background-test-"));
  dbPath = join(dir, "chats.db");
  repo = initDb(dbPath);
  configRef.current = {
    llm: { provider: "openai", model: "test", baseURL: "http://127.0.0.1:11434" },
    insights: { enabled: false },
  };
  server = createGatewayServer(configRef).listen(0, "127.0.0.1");
  return once(server, "listening").then(() => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test listener");
    base = `http://127.0.0.1:${address.port}`;
  });
});

afterEach(async () => {
  for (const release of releaseAll) release();
  releaseAll = [];
  await new Promise((resolve) => setTimeout(resolve, 30));
  const closed = once(server, "close");
  server.close();
  server.closeAllConnections();
  await closed;
  closeDb();
  resetChatRunsForTest();
  rmSync(dir, { force: true, recursive: true });
});

const newSession = () => `sess-bg-${randomBytes(6).toString("hex")}-${sessionSeq++}`;

function postChat(stream: boolean, sessionId: string, signal?: AbortSignal) {
  return fetch(`${base}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: `Question ${sessionId}`, sessionId, stream }),
    signal: signal ?? AbortSignal.timeout(5000),
  });
}

async function json(url: string, init?: RequestInit) {
  const res = await fetch(`${base}${url}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const cancelChat = (sessionId: string) =>
  json("/chat/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });

type Frame = Record<string, unknown> & { done?: boolean };

/** Reads an SSE response in the background and lets a test wait for a frame. */
function tap(response: Response) {
  const frames: Frame[] = [];
  let finished = false;
  const finishedPromise = (async () => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        // Keepalive comments are not data frames.
        if (frame.startsWith("data: ")) frames.push(JSON.parse(frame.slice(6)));
      }
    }
    finished = true;
    return buffer;
  })();
  // A stream the test aborts rejects here; tests that care await it themselves.
  void finishedPromise.catch(() => {});
  const waitFor = async (predicate: (frame: Frame) => boolean, timeoutMs = 3000): Promise<Frame> => {
    const deadline = Date.now() + timeoutMs;
    while (!frames.some(predicate)) {
      if (finished || Date.now() > deadline) {
        throw new Error(`frame not found; stream ${finished ? "ended" : "still open"} with frames ${JSON.stringify(frames)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return frames.find(predicate)!;
  };
  return { frames, waitFor, finishedPromise };
}

async function eventually(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A turn that prints a little, starts a tool step and then waits: until the
 * test releases it or the gateway cancels it.
 */
function hangingTurn() {
  let release: (() => void) | null = null;
  const started = new Promise<OrchestratorOptions>((resolveStarted) => {
    mockOrchestrator.mockImplementation(
      (options) =>
        new Promise((resolve, reject) => {
          options.onToolEvent?.({ type: "start", seq: 0, iteration: 0, name: "read", args: STEP_ARGS });
          options.onStreamChunk?.("early ");
          options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          });
          release = () => {
            options.onToolEvent?.({
              type: "end",
              seq: 0,
              iteration: 0,
              name: "read",
              args: STEP_ARGS,
              result: "SECRET-RESULT-TEXT",
              ok: true,
              durationMs: 5,
              untrusted: false,
              clipped: false,
            });
            options.onStreamChunk?.("late");
            resolve({ content: "early late", tools: trace });
          };
          releaseAll.push(release);
          resolveStarted(options);
        })
    );
  });
  return { started, release: () => release?.() };
}

/**
 * A turn that prints a little and then ignores being stopped — a tool that
 * cannot be interrupted — until the test lets it give up.
 */
function stubbornTurn() {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let noteSuperseded!: () => void;
  const superseded = new Promise<void>((resolve) => {
    noteSuperseded = resolve;
  });
  let giveUp: (() => void) | null = null;
  mockOrchestrator.mockImplementationOnce(
    (options) =>
      new Promise((_resolve, reject) => {
        options.onStreamChunk?.("old ");
        options.signal?.addEventListener("abort", () => noteSuperseded(), { once: true });
        giveUp = () => reject(new DOMException("Aborted", "AbortError"));
        enter();
      })
  );
  return { entered, superseded, giveUp: () => giveUp?.() };
}

const toolStart = (frame: Frame) => frame.toolEvent != null;

describe("background chat turns", () => {
  it("a dropped connection no longer cancels the turn: it finishes and is stored", async () => {
    const sessionId = newSession();
    const turn = hangingTurn();
    const controller = new AbortController();
    const response = await postChat(true, sessionId, controller.signal);
    expect(response.status).toBe(200);
    const stream = tap(response);
    await stream.waitFor(toolStart);
    await turn.started;

    controller.abort();
    await stream.finishedPromise.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(repo.getChatHistory(sessionId, "default")).toEqual([]);

    turn.release();
    await eventually(() => repo.getChatHistory(sessionId, "default").length === 2);

    expect(repo.getChatHistory(sessionId, "default").map((m) => [m.role, m.content])).toEqual([
      ["user", `Question ${sessionId}`],
      ["assistant", "early late"],
    ]);
    expect(repo.listToolCalls(sessionId, "default").map((call) => [call.turnIndex, call.name, call.result])).toEqual([
      [0, "read", "SECRET-RESULT-TEXT"],
    ]);
    const chats = (await json("/chat/list")).body.chats as Array<{ id: string; running?: boolean }>;
    expect(chats.find((chat) => chat.id === sessionId)?.running).toBeUndefined();
  });

  it("cancel stops the turn and keeps what it had done", async () => {
    const sessionId = newSession();
    const turn = hangingTurn();
    const stream = tap(await postChat(true, sessionId));
    await stream.waitFor(toolStart);
    await turn.started;

    expect(await cancelChat(sessionId)).toEqual({ status: 200, body: { ok: true } });

    const terminal = await stream.waitFor((frame) => frame.done === true);
    expect(terminal).toEqual({ done: true, sessionId, error: "Chat cancelled", code: "chat_cancelled" });
    await eventually(() => repo.getChatHistory(sessionId, "default").length === 2);
    expect(repo.getChatHistory(sessionId, "default")).toEqual([
      { role: "user", content: `Question ${sessionId}` },
      // The step was still running: it is stored without a result.
      { role: "assistant", content: "early " },
    ]);
    expect(repo.listToolCalls(sessionId, "default")).toEqual([
      { turnIndex: 0, step: 0, iteration: 0, name: "read", args: STEP_ARGS, result: null, ok: null, untrusted: false, durationMs: null, createdAt: expect.any(Number) },
    ]);
    // The session slot is free again.
    expect(await cancelChat("unknown-session")).toEqual({ status: 200, body: { ok: true } });
  });

  it("sends the headers before the first frame; a cancelled turn that produced nothing stores nothing", async () => {
    const sessionId = newSession();
    mockOrchestrator.mockImplementation(
      (options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        })
    );
    const response = await postChat(true, sessionId);
    // The turn is silent so far (model thinking, tool running) — the client already has its headers.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const stream = tap(response);
    await cancelChat(sessionId);
    await stream.waitFor((frame) => frame.done === true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(repo.getChatHistory(sessionId, "default")).toEqual([]);
  });

  it("a non-stream client is cancelled the same way", async () => {
    const sessionId = newSession();
    const turn = hangingTurn();
    const pending = postChat(false, sessionId);
    await turn.started;
    await cancelChat(sessionId);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessionId, error: "Chat cancelled", code: "chat_cancelled" });
  });

  it("tool steps reach the stream without their result and without looking like a terminal", async () => {
    const sessionId = newSession();
    const turn = hangingTurn();
    const stream = tap(await postChat(true, sessionId));
    await stream.waitFor(toolStart);
    turn.release();
    const terminal = await stream.waitFor((frame) => frame.done === true);

    const steps = stream.frames.filter(toolStart).map((frame) => frame.toolEvent);
    expect(steps).toEqual([
      { type: "start", seq: 0, iteration: 0, name: "read", args: STEP_ARGS },
      { type: "end", seq: 0, iteration: 0, name: "read", args: STEP_ARGS, ok: true, durationMs: expect.any(Number), clipped: false },
    ]);
    // Result text stays on the server; no sessionId / done keys (the browser
    // extension would mistake them for the end of the reply).
    expect(JSON.stringify(steps)).not.toContain("SECRET-RESULT-TEXT");
    expect(steps.every((step) => !("sessionId" in step) && !("done" in step))).toBe(true);
    expect(terminal).toEqual({ done: true, sessionId, content: "early late", userCells: [] });
  });

  it("attach replays what happened, then follows the turn to its end", async () => {
    const sessionId = newSession();
    const turn = hangingTurn();
    const first = tap(await postChat(true, sessionId));
    await first.waitFor(toolStart);
    await turn.started;

    const response = await fetch(`${base}/chat/attach?session_id=${sessionId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const second = tap(response);
    expect(await second.waitFor((frame) => frame.snapshot != null)).toEqual({
      snapshot: {
        userMessage: `Question ${sessionId}`,
        content: "early ",
        steps: [{ type: "start", seq: 0, iteration: 0, name: "read", args: STEP_ARGS }],
      },
    });

    turn.release();
    const terminal = await second.waitFor((frame) => frame.done === true);
    expect(terminal).toMatchObject({ done: true, sessionId, content: "early late" });
    expect(second.frames.filter((frame) => frame.content === "late")).toHaveLength(1);
    // The original stream ends with the same terminal.
    expect(await first.waitFor((frame) => frame.done === true)).toMatchObject(terminal);
  });

  it("attach answers noRun when nothing is running", async () => {
    const sessionId = newSession();
    const response = await fetch(`${base}/chat/attach?session_id=${sessionId}`);
    expect(response.status).toBe(200);
    expect((await response.text()).trim()).toBe(`data: ${JSON.stringify({ done: true, noRun: true, sessionId })}`);
    expect((await fetch(`${base}/chat/attach`)).status).toBe(400);
  });

  it("the list marks chats with a running turn and the history shows the steps of past turns", async () => {
    const sessionId = newSession();
    const turn = hangingTurn();
    const stream = tap(await postChat(true, sessionId));
    await stream.waitFor(toolStart);

    const during = (await json("/chat/list")).body.chats as Array<{ id: string; running?: boolean }>;
    expect(during.find((chat) => chat.id === sessionId)?.running).toBe(true);

    turn.release();
    await stream.waitFor((frame) => frame.done === true);
    const after = (await json("/chat/list")).body.chats as Array<{ id: string; running?: boolean }>;
    expect(after.find((chat) => chat.id === sessionId)?.running).toBeUndefined();

    const history = (await json(`/chat/history?session_id=${sessionId}`)).body.messages as Array<{
      role: string;
      tools?: Array<{ name: string; args: string; ok: boolean; durationMs: number }>;
    }>;
    expect(history[1]!.tools).toEqual([{ name: "read", args: STEP_ARGS, ok: true, durationMs: 5 }]);
    expect(JSON.stringify(history)).not.toContain("SECRET-RESULT-TEXT");
  });

  it("a new message supersedes the running turn and sees it in its history", async () => {
    const sessionId = newSession();
    const turn = hangingTurn();
    const first = tap(await postChat(true, sessionId));
    await first.waitFor(toolStart);
    await turn.started;

    const second = tap(await postChat(true, sessionId));
    const firstTerminal = await first.waitFor((frame) => frame.done === true);
    expect(firstTerminal).toMatchObject({ done: true, code: "chat_cancelled" });

    await eventually(() => repo.getChatHistory(sessionId, "default").length === 2);
    // The superseded turn is stored before the new one starts.
    expect(mockOrchestrator).toHaveBeenCalledTimes(2);
    const secondOptions = mockOrchestrator.mock.calls[1]![0];
    expect(secondOptions.sessionHistory).toEqual([
      { role: "user", content: `Question ${sessionId}`, tools: undefined },
      {
        role: "assistant",
        content: "early ",
        tools: [{ seq: 0, iteration: 0, name: "read", args: STEP_ARGS, untrusted: false }],
      },
    ]);

    releaseAll.forEach((release) => release());
    await second.waitFor((frame) => frame.done === true);
    expect(repo.getChatHistory(sessionId, "default").map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(repo.listToolCalls(sessionId, "default").map((call) => call.turnIndex)).toEqual([0, 2]);
  });

  it("the stored steps of a turn are handed to the model with the next one", async () => {
    const sessionId = newSession();
    mockOrchestrator.mockResolvedValue({ content: "first answer", tools: trace });
    const stream = tap(await postChat(true, sessionId));
    await stream.waitFor((frame) => frame.done === true);

    mockOrchestrator.mockResolvedValue({ content: "second answer" });
    const second = tap(await postChat(true, sessionId));
    await second.waitFor((frame) => frame.done === true);

    const history = mockOrchestrator.mock.calls[1]![0].sessionHistory!;
    expect(history[1]).toEqual({
      role: "assistant",
      content: "first answer",
      tools: [{ seq: 0, iteration: 0, name: "read", args: STEP_ARGS, result: "SECRET-RESULT-TEXT", ok: true, durationMs: 5, untrusted: false }],
    });
  });

  it("keeps an idle stream open with keepalive comments", async () => {
    configRef.current = { ...configRef.current, gateway: { chatKeepaliveMs: 40 } };
    const sessionId = newSession();
    const turn = hangingTurn();
    const response = await postChat(true, sessionId);
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const reader = response.body!.getReader();
    const first = await reader.read();
    await turn.started;
    // Let a few keepalive intervals pass while the turn is busy.
    let idle = "";
    for (let i = 0; i < 4; i++) {
      const { value } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined }>((resolve) => setTimeout(() => resolve({ value: undefined }), 1000)),
      ]);
      if (!value) break;
      idle += new TextDecoder().decode(value);
    }
    expect(idle).toContain(": keepalive");
    turn.release();
    await reader.cancel().catch(() => {});
  });

  it("a turn that hits the wall-clock cap is stopped", async () => {
    configRef.current = { ...configRef.current, gateway: { chatRunMaxMs: 150 } };
    const sessionId = newSession();
    const turn = hangingTurn();
    const stream = tap(await postChat(true, sessionId));
    await turn.started;
    const terminal = await stream.waitFor((frame) => frame.done === true, 3000);
    expect(terminal).toMatchObject({ done: true, code: "chat_cancelled" });
  });

  it("with backgroundChatRuns off a dropped connection cancels the turn, as before", async () => {
    configRef.current = { ...configRef.current, gateway: { backgroundChatRuns: false } };
    const sessionId = newSession();
    const turn = hangingTurn();
    const controller = new AbortController();
    const stream = tap(await postChat(true, sessionId, controller.signal));
    await stream.waitFor(toolStart);
    await turn.started;

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(repo.getChatHistory(sessionId, "default")).toEqual([]);
    // The slot is released: a new turn for the same chat starts at once.
    mockOrchestrator.mockResolvedValue({ content: "next" });
    const next = tap(await postChat(true, sessionId));
    expect(await next.waitFor((frame) => frame.done === true)).toMatchObject({ done: true, content: "next" });
  });

  it("deleting a chat stops its turn and removes everything", async () => {
    const sessionId = newSession();
    const turn = hangingTurn();
    const stream = tap(await postChat(true, sessionId));
    await stream.waitFor(toolStart);
    await turn.started;

    expect(await json(`/chat?session_id=${sessionId}`, { method: "DELETE" })).toEqual({ status: 200, body: { ok: true } });

    expect(repo.getChatHistory(sessionId, "default")).toEqual([]);
    expect(repo.listToolCalls(sessionId, "default")).toEqual([]);
    expect((await json("/chat/list")).body.chats).toEqual([]);
  });

  it("a provider that is not configured releases the chat for the next message", async () => {
    const sessionId = newSession();
    configRef.current.llm = undefined;
    vi.stubEnv("OPENAI_BASE_URL", "");
    const refused = await (await postChat(true, sessionId)).text();
    expect(JSON.parse(refused.trim().slice(6))).toMatchObject({ done: true, code: "llm_not_configured" });
    vi.unstubAllEnvs();

    configRef.current.llm = { provider: "openai", model: "test", baseURL: "http://127.0.0.1:11434" };
    mockOrchestrator.mockResolvedValue({ content: "now it works" });
    const stream = tap(await postChat(true, sessionId));
    expect(await stream.waitFor((frame) => frame.done === true)).toMatchObject({ done: true, content: "now it works" });
  });

  it("a write failure still leaves no half turn behind", async () => {
    const sessionId = newSession();
    mockOrchestrator.mockResolvedValue({ content: "Final", tools: trace });
    const writer = new Database(dbPath);
    writer.exec("CREATE TRIGGER reject_tool BEFORE INSERT ON tool_calls BEGIN SELECT RAISE(ABORT, 'test write failure'); END;");
    writer.close();

    const stream = tap(await postChat(true, sessionId));
    const terminal = await stream.waitFor((frame) => frame.done === true);
    expect(terminal).toMatchObject({ error: expect.stringContaining("test write failure") });
    expect(repo.getChatHistory(sessionId, "default")).toEqual([]);
  });

  it("attach during the setup of a turn already shows the question it answers", async () => {
    configRef.current = { ...configRef.current, gateway: { chatRunSettleWaitMs: 3000 } };
    const sessionId = newSession();
    const stubborn = stubbornTurn();
    await postChat(true, sessionId);
    await stubborn.entered;
    // The new message supersedes the stubborn turn and waits for it to be stored.
    mockOrchestrator.mockResolvedValue({ content: "new answer" });
    void postChat(true, sessionId);
    await stubborn.superseded;

    const attached = tap(await fetch(`${base}/chat/attach?session_id=${sessionId}`));
    expect(await attached.waitFor((frame) => frame.snapshot != null)).toEqual({
      snapshot: { userMessage: `Question ${sessionId}`, content: "", steps: [] },
    });

    stubborn.giveUp();
    expect(await attached.waitFor((frame) => frame.done === true)).toMatchObject({ done: true, content: "new answer" });
  });

  it("a superseded turn that stops only after the new one is stored does not land after it", async () => {
    configRef.current = { ...configRef.current, gateway: { chatRunSettleWaitMs: 50 } };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const sessionId = newSession();
    const stubborn = stubbornTurn();
    const first = tap(await postChat(true, sessionId));
    await first.waitFor((frame) => frame.content === "old ");
    mockOrchestrator.mockResolvedValue({ content: "new answer" });
    const second = tap(await postChat(true, sessionId));
    expect(await second.waitFor((frame) => frame.done === true)).toMatchObject({ done: true, content: "new answer" });

    // Only now does the first turn give up.
    stubborn.giveUp();
    expect(await first.waitFor((frame) => frame.done === true)).toMatchObject({ done: true, code: "chat_cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Stored now, it would follow the new turn as the latest exchange of the chat.
    expect(repo.getChatHistory(sessionId, "default").map((m) => m.content)).toEqual([`Question ${sessionId}`, "new answer"]);
    const lines = logged.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("still stopping 50 ms after it was superseded"))).toBe(true);
    expect(lines.some((line) => line.includes("stopped after the new one was stored; it is not stored"))).toBe(true);
    logged.mockRestore();
  });

  it("attach asks again for a page the turn is still waiting to read, and for a page it opened while nobody was there", async () => {
    const sessionId = newSession();
    const waiting: { page: Promise<unknown> | null; headless: Promise<unknown> | null } = { page: null, headless: null };
    mockOrchestrator.mockImplementation(
      (options) =>
        new Promise((resolve) => {
          options.onOpenBrowserUrl?.("https://example.test/opened");
          waiting.page = options.requestBrowserPageText?.() ?? null;
          waiting.headless = options.requestHeadlessPageText?.("https://example.test/headless") ?? null;
          releaseAll.push(() => resolve({ content: "done" }));
        })
    );
    // A non-stream client: nobody listens to what the turn asks for.
    void postChat(false, sessionId);
    await eventually(() => waiting.page != null && waiting.headless != null);

    const attached = tap(await fetch(`${base}/chat/attach?session_id=${sessionId}`));
    expect(await attached.waitFor((frame) => frame.readBrowserPage != null)).toEqual({
      readBrowserPage: { requestId: expect.any(String) },
    });
    expect(await attached.waitFor((frame) => frame.headlessPageText != null)).toEqual({
      headlessPageText: { requestId: expect.any(String), url: "https://example.test/headless" },
    });
    expect(attached.frames.some((frame) => frame.openBrowserUrl === "https://example.test/opened")).toBe(true);

    // The client that reconnected answers the request for the page it shows.
    const { requestId } = attached.frames.find((frame) => frame.readBrowserPage != null)!.readBrowserPage as { requestId: string };
    expect(
      await json("/api/chat/browser-page-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, text: "page text" }),
      })
    ).toEqual({ status: 200, body: { ok: true } });
    await expect(waiting.page).resolves.toMatchObject({ text: "page text" });

    const late = tap(await fetch(`${base}/chat/attach?session_id=${sessionId}`));
    // The headless request is still waiting: it is asked again.
    await late.waitFor((frame) => frame.headlessPageText != null);
    releaseAll.forEach((release) => release());
    await late.waitFor((frame) => frame.done === true);
    // An answered request and a page a client was already given are not repeated.
    expect(late.frames.some((frame) => frame.readBrowserPage != null)).toBe(false);
    expect(late.frames.some((frame) => frame.openBrowserUrl != null)).toBe(false);
  });

  it("a shutdown stops the running turns the way Stop does, so the chat is there after the restart", async () => {
    const sessionId = newSession();
    const turn = hangingTurn();
    const stream = tap(await postChat(true, sessionId));
    await stream.waitFor(toolStart);
    await turn.started;
    // A client without a stream is stopped the same way.
    const otherSession = newSession();
    const other = hangingTurn();
    const pending = postChat(false, otherSession);
    await other.started;
    const exits: number[] = [];

    await shutdownGateway("SIGTERM", { graceMs: 3000, exit: (code) => exits.push(code) });

    // The client that was still attached sees the turn end — as a restart, not as a Stop…
    expect(await stream.waitFor((frame) => frame.done === true)).toEqual({
      done: true,
      sessionId,
      error: "Gateway is restarting",
      code: "gateway_restart",
    });
    // …and the chat has the question, the text printed so far and the steps.
    expect(repo.getChatHistory(sessionId, "default")).toEqual([
      { role: "user", content: `Question ${sessionId}` },
      { role: "assistant", content: "early ", meta: '{"interruptedBy":"gateway_restart"}' },
    ]);
    expect(repo.listToolCalls(sessionId, "default")).toHaveLength(1);
    expect(exits).toEqual([0]);
    // A restart is not a failed request: 200 with the code, for a client without a stream too.
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessionId: otherSession, error: "Gateway is restarting", code: "gateway_restart" });
    // The same is in the history, for the client that opens the chat after the restart.
    const history = (await json(`/chat/history?session_id=${sessionId}`)).body.messages as Array<{
      role: string;
      interruptedBy?: string;
    }>;
    expect(history.map((message) => [message.role, message.interruptedBy])).toEqual([
      ["user", undefined],
      ["assistant", "gateway_restart"],
    ]);
    // Until the gateway is back nothing starts, and nothing claims to be running.
    const refused = await postChat(true, sessionId);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "Gateway is shutting down", code: "shutting_down" });
    const attach = await (await fetch(`${base}/chat/attach?session_id=${sessionId}`)).text();
    expect(JSON.parse(attach.trim().slice(6))).toMatchObject({ done: true, noRun: true });
  });

  it("a shutdown that runs out of time says which turns are lost", async () => {
    const sessionId = newSession();
    const stubborn = stubbornTurn();
    await postChat(true, sessionId);
    await stubborn.entered;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const exits: number[] = [];

    await shutdownGateway("SIGTERM", { graceMs: 50, exit: (code) => exits.push(code) });

    expect(exits).toEqual([0]);
    const lines = logged.mock.calls.map((call) => String(call[0]));
    // What the turns were given, not the whole grace period: the rest is the container kills'.
    expect(lines.some((line) => line.includes(`1 turn(s) did not stop in the 25 ms given to them (of 50 ms) and are lost: ${sessionId}`))).toBe(true);
    logged.mockRestore();
    stubborn.giveUp();
  });

  it("a shutdown keeps time for the container kills even when the turns use all of theirs", async () => {
    const sessionId = newSession();
    const stubborn = stubbornTurn();
    await postChat(true, sessionId);
    await stubborn.entered;
    const waitForKills = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const started = Date.now();

    await shutdownGateway("SIGTERM", { graceMs: 800, exit: () => {}, waitForKills });
    const elapsed = Date.now() - started;
    stubborn.giveUp();

    // The turns had 400 ms and used all of them: the kills get their 400, exactly.
    expect(waitForKills).toHaveBeenCalledTimes(1);
    expect(waitForKills.mock.calls[0]![0]).toBe(400);
    // …and the whole stop did not outgrow the grace period.
    expect(elapsed).toBeLessThan(800);
  });

  it("a shutdown keeps the kills' reserve even when the event loop ran late", async () => {
    const sessionId = newSession();
    const giveUpRef: { current?: () => void } = {};
    mockOrchestrator.mockImplementation(
      (options) =>
        new Promise((_resolve, reject) => {
          giveUpRef.current = () => reject(new DOMException("Aborted", "AbortError"));
          options.signal?.addEventListener(
            "abort",
            () => {
              // Tearing a skill down can block the loop for a moment: timers fire late.
              const until = Date.now() + 60;
              while (Date.now() < until) {}
              // …and the turn still hangs: it will not settle within its time.
            },
            { once: true }
          );
        })
    );
    await postChat(true, sessionId);
    const waitForKills = vi.fn<(ms: number) => Promise<void>>(async () => {});

    await shutdownGateway("SIGTERM", { graceMs: 800, exit: () => {}, waitForKills });

    // The turns used their whole 400 ms — plus 60 ms of lateness — so only 340
    // was left, and the floor still gave the kills their 400.
    expect(waitForKills.mock.calls[0]![0]).toBe(400);
    giveUpRef.current?.();
  });

  it("the commentary of a turn streams to the client and lands in the attach snapshot", async () => {
    const sessionId = newSession();
    mockOrchestrator.mockImplementation(
      (options) =>
        new Promise((resolve) => {
          options.onStepComment?.("Сверяю расхождения в остановке турнов");
          options.onStreamChunk?.("Читаю ");
          options.onToolEvent?.({ type: "start", seq: 0, iteration: 0, name: "read", args: '{"path":"a"}' });
          releaseAll.push(() => resolve({ content: "done", tools: [] }));
        })
    );
    const stream = tap(await postChat(true, sessionId));
    const commentFrame = await stream.waitFor((frame) => frame.stepComment != null);
    expect(commentFrame.stepComment).toBe("Сверяю расхождения в остановке турнов");

    const attached = tap(await fetch(`${base}/chat/attach?session_id=${sessionId}`));
    const snapshot = await attached.waitFor((frame) => frame.snapshot != null);
    expect((snapshot.snapshot as { comment?: string }).comment).toBe("Сверяю расхождения в остановке турнов");

    releaseAll.forEach((release) => release());
    await attached.waitFor((frame) => frame.done === true);
  });

  it("a shutdown during the setup of a turn reaches its client and keeps the question", async () => {
    configRef.current = {
      ...configRef.current,
      gateway: { chatRunSettleWaitMs: 3000 },
      audit: { logPath: join(dir, "audit-setup.log"), logFormat: "json" },
    };
    const sessionId = newSession();
    const stubborn = stubbornTurn();
    await postChat(true, sessionId);
    await stubborn.entered;
    mockOrchestrator.mockResolvedValue({ content: "new answer" });
    // This message supersedes a running turn: its headers must not wait for the setup to finish.
    const started = Date.now();
    const second = tap(await postChat(true, sessionId));
    expect(Date.now() - started).toBeLessThan(1_000);
    await stubborn.superseded;

    await shutdownGateway("SIGTERM", { graceMs: 3000, exit: () => {} });

    expect(await second.waitFor((frame) => frame.done === true)).toEqual({
      done: true,
      sessionId,
      error: "Gateway is restarting",
      code: "gateway_restart",
    });
    // The question of the turn that never ran is stored, with its marked empty answer.
    const stored = repo.getChatHistory(sessionId, "default");
    expect(stored).toEqual(
      expect.arrayContaining([
        { role: "user", content: `Question ${sessionId}` },
        { role: "assistant", content: "", meta: '{"interruptedBy":"gateway_restart"}' },
      ])
    );
    // The audit tells this stop apart by the event, in the setup path too.
    const events = readFileSync(join(dir, "audit-setup.log"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string });
    expect(events.filter((event) => event.event === "chat_gateway_restart")).toHaveLength(1);
    stubborn.giveUp();
  });

  it("a Stop during the setup ends the stream and stores nothing", async () => {
    configRef.current = { ...configRef.current, gateway: { chatRunSettleWaitMs: 3000 } };
    const sessionId = newSession();
    const stubborn = stubbornTurn();
    await postChat(true, sessionId);
    await stubborn.entered;
    mockOrchestrator.mockResolvedValue({ content: "new answer" });
    const second = tap(await postChat(true, sessionId));
    await stubborn.superseded;

    await cancelChat(sessionId);
    stubborn.giveUp();

    expect(await second.waitFor((frame) => frame.done === true)).toMatchObject({
      done: true,
      code: "chat_cancelled",
    });
    // The user stopped it with nothing to show: only the superseded turn is stored.
    expect(repo.getChatHistory(sessionId, "default")).toEqual([
      { role: "user", content: `Question ${sessionId}` },
      { role: "assistant", content: "old " },
    ]);
  });

  it("a shutdown during the setup answers a client without a stream", async () => {
    configRef.current = { ...configRef.current, gateway: { chatRunSettleWaitMs: 3000 } };
    const sessionId = newSession();
    const stubborn = stubbornTurn();
    await postChat(true, sessionId);
    await stubborn.entered;
    mockOrchestrator.mockResolvedValue({ content: "new answer" });
    const pending = postChat(false, sessionId);
    await stubborn.superseded;

    await shutdownGateway("SIGTERM", { graceMs: 3000, exit: () => {} });

    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessionId,
      error: "Gateway is restarting",
      code: "gateway_restart",
    });
    stubborn.giveUp();
  });

  it("a turn the restart cut short before its first word keeps its question", async () => {
    // Nothing was printed and no tool ran: the model was still thinking.
    mockOrchestrator.mockImplementation(
      (options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          });
        })
    );
    const sessionId = newSession();
    const stream = tap(await postChat(true, sessionId));
    await eventually(() => mockOrchestrator.mock.calls.length === 1);

    await shutdownGateway("SIGTERM", { graceMs: 3000, exit: () => {} });

    expect(await stream.waitFor((frame) => frame.done === true)).toEqual({
      done: true,
      sessionId,
      error: "Gateway is restarting",
      code: "gateway_restart",
    });
    // The question and an answer marked as cut short — not nothing, as if the question had never been asked.
    expect(repo.getChatHistory(sessionId, "default")).toEqual([
      { role: "user", content: `Question ${sessionId}` },
      { role: "assistant", content: "", meta: '{"interruptedBy":"gateway_restart"}' },
    ]);
    const history = (await json(`/chat/history?session_id=${sessionId}`)).body.messages as Array<{
      role: string;
      content: string;
      interruptedBy?: string;
    }>;
    expect(history[1]).toEqual({ role: "assistant", content: "", interruptedBy: "gateway_restart" });

    // The next turn hands the model that as the earlier history, not an empty message.
    resetChatRunsForTest();
    mockOrchestrator.mockResolvedValue({ content: "second answer" });
    const next = tap(await postChat(true, sessionId));
    await next.waitFor((frame) => frame.done === true);
    expect(mockOrchestrator.mock.calls[1]![0].sessionHistory).toEqual([
      { role: "user", content: `Question ${sessionId}` },
      { role: "assistant", content: "[no answer: the gateway was restarting]" },
    ]);
  });

  it("the audit tells a restart from a Stop by the event, not only by its reason", async () => {
    configRef.current = { ...configRef.current, audit: { logPath: join(dir, "audit.log"), logFormat: "json" } };
    // A turn the user stops…
    const stopped = newSession();
    const stoppedTurn = hangingTurn();
    const stoppedStream = tap(await postChat(true, stopped));
    await stoppedStream.waitFor(toolStart);
    await stoppedTurn.started;
    await cancelChat(stopped);
    await stoppedStream.waitFor((frame) => frame.done === true);
    // …and one the gateway goes down on.
    const restarted = newSession();
    const restartedTurn = hangingTurn();
    const restartedStream = tap(await postChat(true, restarted));
    await restartedStream.waitFor(toolStart);
    await restartedTurn.started;
    await shutdownGateway("SIGTERM", { graceMs: 3000, exit: () => {} });
    await restartedStream.waitFor((frame) => frame.done === true);

    const events = readFileSync(join(dir, "audit.log"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; sessionId?: string; details?: { reason?: string } });
    const of = (type: string) => events.filter((event) => event.event === type);
    expect(of("chat_cancelled").map((event) => [event.sessionId, event.details?.reason])).toEqual([
      [stopped, "Chat cancelled"],
    ]);
    expect(of("chat_gateway_restart").map((event) => [event.sessionId, event.details?.reason])).toEqual([
      [restarted, "Gateway is shutting down"],
    ]);
  });
});
