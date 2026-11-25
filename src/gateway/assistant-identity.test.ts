// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const sessionId = "identity-session";
/** 1×1 PNG — small enough for the upload cap, decodable by every image stack. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
let dir: string;
let base: string;
let server: ReturnType<typeof createGatewayServer>;
let repo: ChatRepository;

beforeEach(async () => {
  mockOrchestrator.mockReset();
  dir = mkdtempSync(join(tmpdir(), "claw2-assistant-identity-test-"));
  vi.stubEnv("CLAW2_STATE_DIR", dir);
  repo = initDb(join(dir, "chats.db"));
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

function getIdentity() {
  return fetch(`${base}/api/assistant-identity`, { signal: AbortSignal.timeout(3000) });
}

function putIdentity(body: unknown) {
  return fetch(`${base}/api/assistant-identity`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
}

async function postChatEmotion(): Promise<Response> {
  return fetch(`${base}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Question", sessionId, stream: true }),
    signal: AbortSignal.timeout(3000),
  });
}

describe("gateway /api/assistant-identity", () => {
  it("returns the default preset when nothing was saved", async () => {
    const response = await getIdentity();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      name: undefined,
      avatar: { kind: "preset", value: "🤖" },
      avatarSize: 52,
      isDefault: true,
    });
  });

  it("saves a preset and a name, then serves them back", async () => {
    const putResponse = await putIdentity({ name: "Барсик", avatar: { kind: "preset", value: "🐱" } });
    expect(putResponse.status).toBe(200);
    expect(await putResponse.json()).toEqual({
      name: "Барсик",
      avatar: { kind: "preset", value: "🐱" },
      avatarSize: 52,
      isDefault: false,
    });
    expect(await (await getIdentity()).json()).toEqual({
      name: "Барсик",
      avatar: { kind: "preset", value: "🐱" },
      avatarSize: 52,
      isDefault: false,
    });
    // Single-user mode persists into the state dir.
    const stored = JSON.parse(readFileSync(join(dir, "assistant-identity.json"), "utf-8"));
    expect(stored).toEqual({ name: "Барсик", avatar: { kind: "preset", value: "🐱" } });
  });

  it("accepts an image avatar and serves it as a data URL", async () => {
    const putResponse = await putIdentity({
      avatar: { kind: "image", mimeType: "image/png", dataBase64: TINY_PNG_BASE64 },
    });
    expect(putResponse.status).toBe(200);
    const payload = await putResponse.json();
    expect(payload.avatar).toEqual({
      kind: "image",
      mimeType: "image/png",
      dataUrl: `data:image/png;base64,${TINY_PNG_BASE64}`,
    });
    expect(await (await getIdentity()).json()).toEqual(payload);
  });

  it("drops an SVG avatar (scripting risk) and folds back to the default", async () => {
    const putResponse = await putIdentity({
      name: "X",
      avatar: { kind: "image", mimeType: "image/svg+xml", dataBase64: "PHN2Zy8+" },
    });
    expect(putResponse.status).toBe(200);
    expect(await putResponse.json()).toEqual({
      name: "X",
      avatar: { kind: "preset", value: "🤖" },
      avatarSize: 52,
      isDefault: false,
    });
  });

  it("drops an oversized image instead of storing it", async () => {
    const huge = "A".repeat(2 * 1024 * 1024);
    const putResponse = await putIdentity({
      avatar: { kind: "image", mimeType: "image/png", dataBase64: huge },
    });
    expect(putResponse.status).toBe(200);
    const payload = await putResponse.json();
    expect(payload.avatar).toEqual({ kind: "preset", value: "🤖" });
    expect(payload.isDefault).toBe(true);
  });

  it("clips a too long name to the limit", async () => {
    const putResponse = await putIdentity({ name: "Б".repeat(100) });
    const payload = await putResponse.json();
    expect(payload.name).toHaveLength(64);
  });

  it("stores a chosen avatar size and clamps it into the 24–96 range", async () => {
    const saved = await putIdentity({ avatarSize: 80 });
    expect((await saved.json()).avatarSize).toBe(80);
    const tooBig = await putIdentity({ avatarSize: 150 });
    expect((await tooBig.json()).avatarSize).toBe(96);
    const tooSmall = await putIdentity({ avatarSize: 10 });
    expect((await tooSmall.json()).avatarSize).toBe(24);
    const stored = JSON.parse(readFileSync(join(dir, "assistant-identity.json"), "utf-8"));
    expect(stored.avatarSize).toBe(24);
    // A non-number folds to the default rather than breaking the payload.
    const garbage = await putIdentity({ avatarSize: "big" as unknown as number });
    expect((await garbage.json()).avatarSize).toBe(52);
  });

  it("resets to the default when the avatar is cleared", async () => {
    await putIdentity({ name: "Барсик", avatar: { kind: "preset", value: "🐱" } });
    const reset = await putIdentity({ name: "", avatar: null });
    const resetPayload = await reset.json();
    expect(resetPayload).toEqual({
      name: undefined,
      avatar: { kind: "preset", value: "🤖" },
      avatarSize: 52,
      isDefault: true,
    });
    expect(await (await getIdentity()).json()).toEqual(resetPayload);
  });
});

describe("gateway /chat emotion channel", () => {
  it("streams the emotion frame, puts it into the terminal and the stored history", async () => {
    mockOrchestrator.mockImplementation(async ({ onStreamChunk, onEmotion }) => {
      onEmotion?.("happy");
      onStreamChunk?.("От");
      onStreamChunk?.("лично!");
      return { content: "Отлично!", emotion: "happy" };
    });
    const response = await postChatEmotion();
    expect(response.status).toBe(200);
    const wire = await response.text();
    const frames = wire
      .slice(0, -2)
      .split("\n\n")
      .map((frame) => JSON.parse(frame.slice("data: ".length)));
    expect(frames).toEqual([
      { emotion: "happy" },
      { content: "От" },
      { content: "лично!" },
      { done: true, sessionId, content: "Отлично!", emotion: "happy", userCells: [] },
    ]);
    const history = await fetch(`${base}/chat/history?session_id=${sessionId}`, {
      signal: AbortSignal.timeout(3000),
    });
    expect(await history.json()).toEqual({
      messages: [
        { role: "user", content: "Question" },
        { role: "assistant", content: "Отлично!", emotion: "happy" },
      ],
    });
  });

  it("keeps the history clean when the model gave no mood tag", async () => {
    mockOrchestrator.mockImplementation(async () => ({ content: "Просто ответ" }));
    await postChatEmotion();
    const history = await fetch(`${base}/chat/history?session_id=${sessionId}`, {
      signal: AbortSignal.timeout(3000),
    });
    expect(await history.json()).toEqual({
      messages: [
        { role: "user", content: "Question" },
        { role: "assistant", content: "Просто ответ" },
      ],
    });
  });
});
