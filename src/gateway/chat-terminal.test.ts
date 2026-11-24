// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import Database from "better-sqlite3";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Claw2Config } from "../config/types.js";
import { runOrchestrator } from "../core/orchestrator.js";
import { closeDb, initDb, type ChatRepository } from "./db/index.js";
import { createGatewayServer } from "./server.js";

vi.mock("../core/orchestrator.js", () => ({ runOrchestrator: vi.fn() }));

const configRef: { current: Claw2Config } = { current: {} };
const mockOrchestrator = vi.mocked(runOrchestrator);
const sessionId = "test-session";
let dir: string;
let dbPath: string;
let base: string;
let server: ReturnType<typeof createGatewayServer>;
let repo: ChatRepository;

beforeEach(async () => {
  mockOrchestrator.mockReset();
  dir = mkdtempSync(join(tmpdir(), "claw2-chat-terminal-test-"));
  dbPath = join(dir, "chats.db");
  repo = initDb(dbPath);
  configRef.current = {
    llm: { provider: "openai", model: "test", baseURL: "http://127.0.0.1:11434" },
    insights: { enabled: false },
  };
  server = createGatewayServer(configRef).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test listener");
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  const closed = once(server, "close");
  server.close();
  server.closeAllConnections();
  await closed;
  closeDb();
  rmSync(dir, { force: true, recursive: true });
  vi.unstubAllEnvs();
});

function postChat(stream: boolean) {
  return fetch(`${base}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Question", sessionId, stream }),
    signal: AbortSignal.timeout(3000),
  });
}

async function chatEvents(response: Response): Promise<Record<string, unknown>[]> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const wire = await response.text();
  expect(wire.endsWith("\n\n")).toBe(true);
  return wire.slice(0, -2).split("\n\n").map((frame) => {
    expect(frame).toMatch(/^data: /);
    return JSON.parse(frame.slice(6));
  });
}

describe("gateway /chat terminal and persistence", () => {
  it("sends one JSON terminal when the provider is not configured", async () => {
    configRef.current.llm = undefined;
    vi.stubEnv("OPENAI_BASE_URL", "");
    const frames = await chatEvents(await postChat(true));
    expect(frames).toEqual([{
      done: true, sessionId, code: "llm_not_configured", error: "llm.baseURL not set",
    }]);
    expect(mockOrchestrator).not.toHaveBeenCalled();
    expect(repo.getChatHistory(sessionId, "default")).toEqual([]);
  });

  it("ends the stream with a single success terminal after saving the full turn", async () => {
    mockOrchestrator.mockImplementation(async ({ onStreamChunk }) => {
      onStreamChunk?.("Par");
      onStreamChunk?.("tial");
      return { content: "Final", lastRunId: 17 };
    });
    expect(await chatEvents(await postChat(true))).toEqual([
      { content: "Par" },
      { content: "tial" },
      { done: true, sessionId, content: "Final", lastRunId: 17, userCells: [] },
    ]);
    expect(repo.getChatHistory(sessionId, "default")).toEqual([
      { role: "user", content: "Question" },
      { role: "assistant", content: "Final" },
    ]);
    expect(repo.listTranscript(sessionId, "default").totalCount).toBe(2);
  });

  it.each([true, false])("propagates a write failure without persisting half a turn (stream=%s)", async (stream) => {
    const writer = new Database(dbPath);
    try {
      writer.exec(`CREATE TRIGGER reject_assistant BEFORE INSERT ON transcript_messages
        WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'test write failure'); END;`);
    } finally {
      writer.close();
    }
    mockOrchestrator.mockImplementation(async ({ onStreamChunk }) => {
      onStreamChunk?.("Partial");
      return { content: "Final" };
    });
    const response = await postChat(stream);
    if (stream) {
      expect(await chatEvents(response)).toEqual([
        { content: "Partial" },
        { done: true, sessionId, error: expect.stringContaining("test write failure") },
      ]);
    } else {
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ sessionId, error: expect.stringContaining("test write failure") });
    }
    expect(repo.getChatHistory(sessionId, "default")).toEqual([]);
    expect(repo.listTranscript(sessionId, "default").totalCount).toBe(0);
  });
});
