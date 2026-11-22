// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Claw2Config } from "../config/types.js";
import { runOrchestrator } from "../core/orchestrator.js";
import { closeDb, initDb, type ChatRepository } from "./db/index.js";
import { createGatewayServer } from "./server.js";

vi.mock("../core/orchestrator.js", () => ({ runOrchestrator: vi.fn() }));

const configRef: { current: Claw2Config } = { current: {} };
const mockOrchestrator = vi.mocked(runOrchestrator);
let dir: string;
let repo: ChatRepository;
let base: string;
let server: ReturnType<typeof createGatewayServer>;

beforeEach(async () => {
  mockOrchestrator.mockReset();
  dir = mkdtempSync(join(tmpdir(), "claw2-chat-rename-flags-"));
  repo = initDb(join(dir, "chats.db"));
  const uploadsDir = join(dir, "agents", "uploads");
  const outputDir = join(dir, "agents", "output");
  mkdirSync(uploadsDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  configRef.current = {
    agentsDir: join(dir, "agents"),
    llm: { provider: "openai", model: "test", baseURL: "http://127.0.0.1:11434" },
    insights: { enabled: false },
  };
  server = createGatewayServer(configRef).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  const closed = once(server, "close");
  server.close();
  server.closeAllConnections();
  await closed;
  closeDb();
  rmSync(dir, { force: true, recursive: true });
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });

const listTitles = async () =>
  (await (await fetch(`${base}/chat/list`, { signal: AbortSignal.timeout(3000) })).json()) as {
    chats: { id: string; title: string; titleManual?: boolean; hasImages?: boolean; hasDocs?: boolean }[];
  };

describe("chat titles and attachment flags", () => {
  it("a manually renamed chat keeps its title against automatic titling", async () => {
    mockOrchestrator.mockImplementation(async () => ({ content: "ok" }));
    // First message creates the chat with a derived title.
    await post("/chat", { message: "Что раскопать по санкциям сегодня?", sessionId: "chat-a", stream: false });
    // Auto title path (browser page title from the client) still works while not manual.
    await post("/chat", { message: "второй вопрос", sessionId: "chat-a", stream: false, chatTitle: "Страница: отчёт" });
    let listed = await listTitles();
    expect(listed.chats.find((c) => c.id === "chat-a")?.title).toBe("Страница: отчёт");

    // Manual rename via PATCH marks the title manual…
    const renamed = await fetch(`${base}/chat`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "chat-a", title: "Моё название" }),
      signal: AbortSignal.timeout(3000),
    });
    expect(renamed.status).toBe(200);
    // …and the automatic path must not overwrite it anymore.
    await post("/chat", { message: "третий вопрос", sessionId: "chat-a", stream: false, chatTitle: "Чужое автоимя" });
    listed = await listTitles();
    const chat = listed.chats.find((c) => c.id === "chat-a");
    expect(chat?.title).toBe("Моё название");
    expect(chat?.titleManual).toBe(true);
  });

  it("attachment indicators come from message refs and session-prefixed disk files", async () => {
    repo.ensureChat("chat-img", "default", "С картинкой");
    repo.ensureChat("chat-doc", "default", "С документом");
    repo.ensureChat("chat-plain", "default", "Без вложений");
    // Image cell in message meta (attached/generated image).
    repo.appendMessage("chat-img", "default", "user", "вот картинка", JSON.stringify([
      { type: "image", content: "/files/output/pic.png" },
    ]));
    // Document reference in message text.
    repo.appendMessage("chat-doc", "default", "assistant", "Отчёт: /files/uploads/report.pdf готов");
    // Disk files with the session prefix (not quoted in any message).
    writeFileSync(join(dir, "agents", "uploads", "chat-doc_scan.xlsx"), "x");
    writeFileSync(join(dir, "agents", "output", "chat-img_chart.png"), "x");

    const listed = await listTitles();
    const byId = new Map(listed.chats.map((c) => [c.id, c]));
    expect(byId.get("chat-img")).toMatchObject({ hasImages: true, hasDocs: false });
    expect(byId.get("chat-doc")).toMatchObject({ hasImages: false, hasDocs: true });
    expect(byId.get("chat-plain")).toMatchObject({ hasImages: false, hasDocs: false });
  });
});
