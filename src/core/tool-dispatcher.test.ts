// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Claw2Config } from "../config/types.js";
import { dispatchToolCall, knownToolNames, type ToolDispatchContext, type ToolDispatchState } from "./tool-dispatcher.js";
import { getChatTools } from "./llm.js";
import { runAgent, runAgentHost } from "../sandbox/run-agent.js";
import { memoryRecall, memoryRetire, memoryTouch, memoryWrite } from "../memory/index.js";
import { acceptSkill, runCodeSkill } from "../coding/run-code-skill.js";
import { writeAgent } from "../agents/write-agent.js";
import { toolEdit, toolListDir, toolRead, toolWrite } from "../tools/fs-tools.js";
import { toolWebFetch } from "../tools/web-fetch.js";
import { toolMessage } from "../tools/message.js";
import { toolReadSecret } from "../tools/read-secret.js";
import { toolPhoneCall } from "../tools/phone-call.js";
import { toolRoomHistory, toolRoomSend } from "../tools/peer-chat.js";
import { toolGenerateImage } from "../tools/generate-image.js";
import { toolSearch } from "../tools/search.js";
import { reminderAdd, reminderDelete, reminderList, tasksAdd, tasksDelete, tasksDone, tasksList } from "../tasks/store.js";
import { appendModelChronicleEntry } from "../claw-cache/index.js";
import {
  TRANSCRIPT_LIST_MAX_LIMIT,
  TRANSCRIPT_MAX_TOOL_CALLS_PER_TURN,
  TRANSCRIPT_SEARCH_MAX_LIMIT,
  type TranscriptSessionAccess,
} from "../transcript/index.js";
import { hasUntrustedOrigin, resetProvenanceForTest } from "../security/origin.js";
import { releaseSidebarSession } from "../sidebar/store.js";

vi.mock("../sandbox/run-agent.js", () => ({ runAgent: vi.fn(), runAgentHost: vi.fn() }));
vi.mock("../memory/index.js", () => ({
  formatMemoryHit: vi.fn((c: { text: string }, i?: number) => `[${i}] ${c.text}`),
  memoryRecall: vi.fn(),
  memoryRetire: vi.fn(),
  memoryTouch: vi.fn(),
  memoryWrite: vi.fn(),
}));
vi.mock("../coding/run-code-skill.js", () => ({ runCodeSkill: vi.fn(), acceptSkill: vi.fn() }));
vi.mock("../agents/write-agent.js", () => ({ writeAgent: vi.fn() }));
vi.mock("../tools/fs-tools.js", () => ({ toolRead: vi.fn(), toolWrite: vi.fn(), toolEdit: vi.fn(), toolListDir: vi.fn() }));
vi.mock("../tools/web-fetch.js", () => ({ toolWebFetch: vi.fn() }));
vi.mock("../tools/message.js", () => ({ toolMessage: vi.fn() }));
vi.mock("../tools/read-secret.js", () => ({ toolReadSecret: vi.fn() }));
vi.mock("../tools/phone-call.js", () => ({ toolPhoneCall: vi.fn() }));
vi.mock("../tools/peer-chat.js", () => ({ toolRoomSend: vi.fn(), toolRoomHistory: vi.fn() }));
vi.mock("../tools/generate-image.js", () => ({ toolGenerateImage: vi.fn() }));
vi.mock("../tools/search.js", async (original) => ({
  ...(await original<typeof import("../tools/search.js")>()),
  toolSearch: vi.fn(),
}));
vi.mock("../tasks/store.js", () => ({
  tasksAdd: vi.fn(),
  tasksList: vi.fn(),
  tasksDone: vi.fn(),
  tasksDelete: vi.fn(),
  reminderAdd: vi.fn(),
  reminderList: vi.fn(),
  reminderDelete: vi.fn(),
}));
vi.mock("../claw-cache/index.js", () => ({ appendModelChronicleEntry: vi.fn(), searchChronicleSession: vi.fn() }));
vi.mock("../agent-selection/store.js", () => ({ ensureTask: vi.fn(), ensureBootstrapVersionFromScript: vi.fn() }));
vi.mock("../agent-selection/selection.js", () => ({ pickVersionForRun: vi.fn(), recordRunAndMaybeSelect: vi.fn() }));
vi.mock("../agent-selection/task-id.js", () => ({ computeTaskId: vi.fn() }));
vi.mock("../agent-selection/log.js", () => ({ selectionLog: vi.fn() }));

const SESSION = "sess-dispatch-test";
let agentsDir: string;

function makeState(): ToolDispatchState {
  return {
    trifecta: { dataAccess: false, untrustedContent: false },
    sensitiveContents: [],
    memoryReturnedContents: [],
    transcriptToolCalls: 0,
    generateImageSucceeded: false,
    sidebarUpdated: false,
    lastRunId: null,
  };
}

function makeCtx(over: Partial<ToolDispatchContext> = {}): ToolDispatchContext {
  return {
    config: {} as Claw2Config,
    client: { chat: { completions: {} } } as unknown as ToolDispatchContext["client"],
    sessionId: SESSION,
    cacheId: "default",
    isSuperuser: false,
    elevatedSession: false,
    agentsDir,
    ...over,
  };
}

function cfg(over: Partial<Claw2Config>): Claw2Config {
  return over as Claw2Config;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetProvenanceForTest();
  releaseSidebarSession(SESSION);
  agentsDir = mkdtempSync(join(tmpdir(), "claw2-dispatcher-test-"));
});

afterEach(() => {
  rmSync(agentsDir, { force: true, recursive: true });
});

describe("tool dispatcher", () => {
  it("reports an unknown tool as an Error the model can read", async () => {
    expect(await dispatchToolCall(makeCtx(), makeState(), "no_such_tool", {})).toBe(
      "Error: unknown or unsupported tool: no_such_tool"
    );
  });

  it("has a handler for every tool the model can be offered", () => {
    const config = cfg({
      agentsDir,
      memory: { enabled: true },
      tools: { sdUrl: "http://127.0.0.1:1" },
      gateway: { chatsDbPath: "chats.db" },
      secrets: { allowlist: ["A"] },
      llmBridge: { enabled: true, url: "http://127.0.0.1:1", agentId: "a", conversationId: "c" },
    });
    const offered = getChatTools(config).map((tool) => tool.function.name);
    expect(offered.length).toBeGreaterThan(30);
    for (const name of offered) expect(knownToolNames()).toContain(name);
    // The remaining optional tools need live services to be offered.
    expect(knownToolNames()).toEqual(
      expect.arrayContaining(["phone_call", "chronicle_remember", "chronicle_search"])
    );
  });

  describe("run_agent", () => {
    const allowed = () => cfg({ skills: { allowlist: ["a.js"] }, sandbox: { image: "node:20-alpine" } });

    it("runs an allowed skill in the sandbox and wraps its output as untrusted", async () => {
      vi.mocked(runAgent).mockResolvedValue({ stdout: "hello", stderr: "", exitCode: 0 });
      const onRunAgent = vi.fn();
      const state = makeState();
      const config = allowed();
      const out = await dispatchToolCall(makeCtx({ config, onRunAgent }), state, "run_agent", { script: "a.js", args: ["x"] });
      expect(runAgent).toHaveBeenCalledWith(config, expect.objectContaining({ script: "a.js", args: ["x"] }), undefined);
      expect(out).toBe("<<<EXT>>>\nSource: run_agent\n---\nstdout:\nhello\n\nstderr:\n\n\nexitCode: 0\n<<</EXT>>>");
      expect(state.trifecta.untrustedContent).toBe(true);
      expect(hasUntrustedOrigin(SESSION)).toBe(true);
      expect(onRunAgent).toHaveBeenCalledWith("a.js", 0);
    });

    it("refuses a skill outside the allowlist and points the user at /allow", async () => {
      const out = await dispatchToolCall(makeCtx({ config: allowed() }), makeState(), "run_agent", { script: "b.js" });
      expect(out).toBe(
        "Error: skill «b.js» is not in skills.allowlist, so it will not run. Tell the user to confirm it: they should send /allow b.js in the chat (or add the skill to skills.allowlist in the config). Do not claim the skill has already run."
      );
      expect(runAgent).not.toHaveBeenCalled();
    });

    it("refuses a disabled skill and a missing script name", async () => {
      const disabled = cfg({ disabledAgents: ["a.js"], skills: { allowlist: ["a.js"] } });
      expect(await dispatchToolCall(makeCtx({ config: disabled }), makeState(), "run_agent", { script: "a.js" })).toContain("is disabled");
      expect(await dispatchToolCall(makeCtx({ config: allowed() }), makeState(), "run_agent", {})).toBe("Error: run_agent requires script");
      expect(runAgent).not.toHaveBeenCalled();
    });

    it("does not pass uploads/output or memory content into a skill", async () => {
      const state = makeState();
      state.sensitiveContents.push("FILE-CONTENT");
      state.memoryReturnedContents.push("MEMORY-CONTENT");
      const run = (args: Record<string, unknown>) => dispatchToolCall(makeCtx({ config: allowed() }), state, "run_agent", { script: "a.js", ...args });
      expect(await run({ stdin: "x FILE-CONTENT y" })).toContain("cannot pass content from uploads, output or internal memory");
      expect(await run({ args: ["MEMORY-CONTENT"] })).toContain("cannot pass content from uploads, output or internal memory");
      expect(runAgent).not.toHaveBeenCalled();
    });

    it("uses the host sandbox when Docker is off", async () => {
      vi.mocked(runAgentHost).mockResolvedValue({ stdout: "", stderr: "err", exitCode: 1 });
      const config = cfg({ skills: { allowlist: ["a.js"] }, sandbox: { image: "node:20-alpine", useDocker: false } });
      const out = await dispatchToolCall(makeCtx({ config }), makeState(), "run_agent", { script: "a.js" });
      expect(runAgentHost).toHaveBeenCalledTimes(1);
      expect(runAgent).not.toHaveBeenCalled();
      expect(out).toContain("exitCode: 1");
    });

    it("hands the turn's cancel signal to the skill runner, code_skill and image generation", async () => {
      vi.mocked(runAgent).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
      vi.mocked(runCodeSkill).mockResolvedValue({ ok: true, message: "candidates" });
      vi.mocked(toolGenerateImage).mockResolvedValue({ ok: false, error: "down" });
      const controller = new AbortController();
      const ctx = makeCtx({ config: allowed(), signal: controller.signal });
      await dispatchToolCall(ctx, makeState(), "run_agent", { script: "a.js" });
      expect(runAgent).toHaveBeenCalledWith(allowed(), expect.anything(), controller.signal);
      await dispatchToolCall(ctx, makeState(), "code_skill", { script: "x.js", task: "do" });
      expect(runCodeSkill).toHaveBeenCalledWith(allowed(), { script: "x.js", task: "do" }, controller.signal);
      await dispatchToolCall(ctx, makeState(), "generate_image", { prompt: "cat" });
      expect(toolGenerateImage).toHaveBeenCalledWith(allowed(), "cat", expect.anything(), controller.signal);
    });
  });

  describe("file tools", () => {
    it("returns the file, arms data access and treats uploads content as sensitive", async () => {
      vi.mocked(toolRead).mockReturnValue({ ok: true, content: "line1\nline2" });
      const state = makeState();
      const config = cfg({});
      const out = await dispatchToolCall(makeCtx({ config }), state, "read", { path: "uploads/a.txt" });
      expect(toolRead).toHaveBeenCalledWith(config, "uploads/a.txt", undefined, undefined);
      expect(out).toBe("line1\nline2");
      expect(state.trifecta.dataAccess).toBe(true);
      expect(state.sensitiveContents).toEqual(["line1\nline2"]);
    });

    it("passes a line window to read for paging", async () => {
      vi.mocked(toolRead).mockReturnValue({ ok: true, content: "[lines 3-4 of 9]\nc\nd" });
      const out = await dispatchToolCall(makeCtx(), makeState(), "read", { path: "output/big.csv", offset: 3.7, limit: 2 });
      expect(toolRead).toHaveBeenCalledWith({}, "output/big.csv", undefined, { offset: 3, limit: 2 });
      expect(out).toBe("[lines 3-4 of 9]\nc\nd");
      await dispatchToolCall(makeCtx(), makeState(), "read", { path: "output/big.csv", offset: "3" });
      expect(toolRead).toHaveBeenLastCalledWith({}, "output/big.csv", undefined, undefined);
    });

    it("keeps ordinary reads out of the sensitive list and reports errors", async () => {
      vi.mocked(toolRead)
        .mockReturnValueOnce({ ok: true, content: "skill source" })
        .mockReturnValueOnce({ ok: false, error: "path not allowed" });
      const state = makeState();
      expect(await dispatchToolCall(makeCtx(), state, "read", { path: "agents/a.js" })).toBe("skill source");
      expect(state.sensitiveContents).toEqual([]);
      expect(await dispatchToolCall(makeCtx(), state, "read", { path: "../etc/passwd" })).toBe("Error: path not allowed");
      expect(await dispatchToolCall(makeCtx(), state, "read", {})).toBe("Error: read requires path");
    });

    it("maps write, edit and list_dir results", async () => {
      vi.mocked(toolWrite).mockReturnValue({ ok: true });
      vi.mocked(toolEdit).mockReturnValue({ ok: false, error: "not found" });
      vi.mocked(toolListDir).mockReturnValue({ ok: true, entries: [] });
      const state = makeState();
      expect(await dispatchToolCall(makeCtx(), state, "write", { path: "output/a.txt", content: "x" })).toBe("Written.");
      expect(await dispatchToolCall(makeCtx(), state, "edit", { path: "a.js", searchText: "a", replaceText: "b" })).toBe("Error: not found");
      expect(await dispatchToolCall(makeCtx(), state, "list_dir", { path: "agents" })).toBe("(empty)");
      expect(await dispatchToolCall(makeCtx(), state, "write", {})).toBe("Error: write requires path");
      expect(await dispatchToolCall(makeCtx(), state, "edit", {})).toBe("Error: edit requires path");
      expect(await dispatchToolCall(makeCtx(), state, "list_dir", {})).toBe("Error: list_dir requires path");
    });
  });

  describe("memory", () => {
    it("saves with remember, bound to the recognized user, and reports replaces", async () => {
      vi.mocked(memoryWrite).mockResolvedValue({ ok: true, id: "m1" } as never);
      const state = makeState();
      const ctx = makeCtx({ recognizedUser: "u1", isSuperuser: true });
      expect(await dispatchToolCall(ctx, state, "remember", { text: "note", importance: 9 })).toBe("Saved: m1");
      expect(memoryWrite).toHaveBeenLastCalledWith(ctx.client, {}, "note", "user", "u1", 1, false, undefined);
      const out = await dispatchToolCall(ctx, state, "remember", { text: "note", source: "internal", replaces: " m0 " });
      expect(out).toBe("Saved: m1 (replaced m0; old version retired)");
      expect(memoryWrite).toHaveBeenLastCalledWith(ctx.client, {}, "note", "internal", "u1", undefined, false, { replaces: "m0", isSuperuser: true });
    });

    it("turns a failing store into an Error the model can read", async () => {
      vi.mocked(memoryWrite).mockResolvedValue({ ok: false, reason: "no backend" } as never);
      expect(await dispatchToolCall(makeCtx(), makeState(), "remember", { text: "x" })).toBe("Error: no backend");
      vi.mocked(memoryWrite).mockRejectedValue(new Error("boom"));
      expect(await dispatchToolCall(makeCtx(), makeState(), "remember", { text: "x" })).toBe(
        "Remember failed: boom. Check out Ollama (embeddings) and Chroma."
      );
    });

    it("memory_forget and memory_touch address a record by id", async () => {
      vi.mocked(memoryRetire).mockResolvedValue({ ok: true } as never);
      vi.mocked(memoryTouch).mockResolvedValue({ ok: true } as never);
      const ctx = makeCtx({ recognizedUser: "u1" });
      expect(await dispatchToolCall(ctx, makeState(), "memory_forget", {})).toBe("Error: memory_forget requires id");
      expect(await dispatchToolCall(ctx, makeState(), "memory_forget", { id: " m1 " })).toBe("Retired: m1");
      expect(memoryRetire).toHaveBeenCalledWith({}, "m1", { userId: "u1", isSuperuser: false });
      expect(await dispatchToolCall(ctx, makeState(), "memory_touch", { id: "m1" })).toBe("Verified: m1");
    });

    it("memory_search requires a query and keeps the hits inside the chat", async () => {
      vi.mocked(memoryRecall).mockResolvedValue({ chunks: [{ text: "fact one", untrustedOrigin: true }] } as never);
      const state = makeState();
      const ctx = makeCtx();
      expect(await dispatchToolCall(ctx, state, "memory_search", {})).toBe("Error: memory_search requires query");
      const out = await dispatchToolCall(ctx, state, "memory_search", { query: "fact", limit: 99 });
      expect(memoryRecall).toHaveBeenCalledWith(ctx.client, {}, "fact", 20, undefined);
      expect(out).toBe("[1] fact one");
      expect(state.memoryReturnedContents).toEqual(["fact one"]);
      expect(state.trifecta.untrustedContent).toBe(true);
      expect(hasUntrustedOrigin(SESSION)).toBe(true);
    });
  });

  describe("transcript", () => {
    const transcript = {
      list: vi.fn(),
      search: vi.fn(),
      read: vi.fn(),
    };
    const withTranscript = () => makeCtx({ transcript: transcript as unknown as TranscriptSessionAccess });

    it("is unavailable without a chat database", async () => {
      expect(await dispatchToolCall(makeCtx(), makeState(), "transcript_list", {})).toBe(
        "Error: transcript tools unavailable (no chat database for this session)"
      );
    });

    it("caps the number of calls per turn", async () => {
      const state = makeState();
      state.transcriptToolCalls = TRANSCRIPT_MAX_TOOL_CALLS_PER_TURN;
      const out = await dispatchToolCall(withTranscript(), state, "transcript_read", { fromId: 1 });
      expect(out).toContain(`transcript tool limit reached this turn (max ${TRANSCRIPT_MAX_TOOL_CALLS_PER_TURN})`);
      expect(transcript.read).not.toHaveBeenCalled();
      expect(state.transcriptToolCalls).toBe(TRANSCRIPT_MAX_TOOL_CALLS_PER_TURN);
    });

    it("lists, searches and reads through the session access", async () => {
      transcript.list.mockReturnValue({
        items: [{ messageId: 7, role: "user", preview: "hi", createdAt: 1 }],
        totalCount: 9,
        nextAfterId: 7,
      });
      transcript.search.mockReturnValue([{ messageId: 3, role: "assistant", excerpt: "ex", createdAt: 2 }]);
      transcript.read.mockReturnValue({
        messages: [{ messageId: 3, role: "assistant", content: "full", createdAt: 2 }],
        truncated: true,
        anchorMessageId: 3,
      });
      const state = makeState();
      expect(await dispatchToolCall(withTranscript(), state, "transcript_list", { afterId: 5, limit: 999 })).toBe(
        "7 user ts=1: hi\n\n[total=9, nextAfterId=7]"
      );
      expect(transcript.list).toHaveBeenCalledWith({ afterId: 5, limit: TRANSCRIPT_LIST_MAX_LIMIT });
      expect(await dispatchToolCall(withTranscript(), state, "transcript_search", { query: "ex", limit: 999 })).toBe(
        "[1] id=3 role=assistant ts=2\nex"
      );
      expect(transcript.search).toHaveBeenCalledWith("ex", TRANSCRIPT_SEARCH_MAX_LIMIT);
      expect(await dispatchToolCall(withTranscript(), state, "transcript_read", { messageId: 3 })).toBe(
        "--- id=3 role=assistant ts=2 ---\nfull\n\n[truncated: output char limit]"
      );
      expect(await dispatchToolCall(withTranscript(), state, "transcript_read", {})).toBe(
        "Error: transcript_read requires fromId, messageId, or query"
      );
      // A rejected call still spends budget, exactly as before the move.
      expect(state.transcriptToolCalls).toBe(4);
    });
  });

  describe("web and browser", () => {
    it("search requires a query", async () => {
      expect(await dispatchToolCall(makeCtx(), makeState(), "search", {})).toBe("Error: search requires query");
    });

    it("search prefers the headless SERP and marks it untrusted", async () => {
      const requestHeadlessPageText = vi
        .fn()
        .mockResolvedValue({ url: "https://ddg.test/?q=x", title: "Results", text: "1. First — see /home/me/notes\n2. Second" });
      const state = makeState();
      const out = await dispatchToolCall(makeCtx({ requestHeadlessPageText }), state, "search", { query: "x" });
      expect(requestHeadlessPageText).toHaveBeenCalledTimes(1);
      expect(out).toMatch(/^<<<EXT>>>\nSource: search\nSender: https:\/\/ddg\.test\/\?q=x\nSubject: .+\n---\nSearch engine results for: x\n/);
      expect(out).toContain("Title: Results");
      expect(out).toContain("[path redacted]");
      expect(state.trifecta.untrustedContent).toBe(true);
      expect(hasUntrustedOrigin(SESSION)).toBe(true);
    });

    it("search falls back to the search API when no headless page is available", async () => {
      const ctx = makeCtx();
      vi.mocked(toolSearch).mockResolvedValue({ ok: true, content: "SERP text" });
      expect(await dispatchToolCall(ctx, makeState(), "search", { query: "x" })).toBe(
        "<<<EXT>>>\nSource: search\n---\nSERP text\n<<</EXT>>>"
      );
      expect(toolSearch).toHaveBeenCalledWith({}, "x", undefined);
      vi.mocked(toolSearch).mockResolvedValue({ ok: false, error: "no engine" });
      expect(await dispatchToolCall(ctx, makeState(), "search", { query: "x" })).toBe("Error: no engine");
    });

    it("web_fetch blocks sensitive URLs and marks fetched pages untrusted", async () => {
      const state = makeState();
      state.sensitiveContents.push("TOP-SECRET");
      const ctx = makeCtx();
      expect(await dispatchToolCall(ctx, state, "web_fetch", { url: "https://x.test/?q=TOP-SECRET" })).toBe(
        "Error: URL must not contain content from uploads, output or internal memory."
      );
      expect(toolWebFetch).not.toHaveBeenCalled();
      vi.mocked(toolWebFetch).mockResolvedValue({ ok: true, content: "page" });
      expect(await dispatchToolCall(ctx, state, "web_fetch", { url: "https://x.test/" })).toBe("page");
      expect(state.trifecta.untrustedContent).toBe(true);
      expect(await dispatchToolCall(ctx, state, "web_fetch", {})).toBe("Error: web_fetch requires url");
    });

    it("open_browser validates the URL and asks the UI to navigate", async () => {
      const onOpenBrowserUrl = vi.fn();
      const ctx = makeCtx({ onOpenBrowserUrl });
      // A value without a scheme gets https:// prefixed; what then fails to parse is rejected.
      expect(await dispatchToolCall(ctx, makeState(), "open_browser", { url: "not a url" })).toBe("Error: invalid URL");
      expect(await dispatchToolCall(ctx, makeState(), "open_browser", {})).toBe("Error: open_browser requires url");
      const out = await dispatchToolCall(ctx, makeState(), "open_browser", { url: "example.test/page" });
      expect(onOpenBrowserUrl).toHaveBeenCalledWith("https://example.test/page");
      expect(out).toContain("Opened https://example.test/page");
    });
  });

  describe("message (webhook)", () => {
    const webhookUrl = "https://hook.test/x";

    it("requires a webhookUrl", async () => {
      expect(await dispatchToolCall(makeCtx(), makeState(), "message", { body: "x" })).toBe("Error: message requires webhookUrl");
    });

    it("never forwards uploads/output or memory content", async () => {
      const state = makeState();
      state.sensitiveContents.push("PRIVATE-FILE");
      state.memoryReturnedContents.push("PRIVATE-MEMORY");
      const ctx = makeCtx();
      expect(await dispatchToolCall(ctx, state, "message", { webhookUrl, body: " PRIVATE-FILE " })).toBe(
        "Error: sending content from uploads or output is not allowed."
      );
      expect(await dispatchToolCall(ctx, state, "message", { webhookUrl, body: "PRIVATE-MEMORY" })).toBe(
        "Error: sending content from internal memory outside the chat is not allowed."
      );
      expect(toolMessage).not.toHaveBeenCalled();
    });

    it("honours deny_bulk and the lethal trifecta", async () => {
      const deny = cfg({ tools: { message: { policy: "deny_bulk" } } });
      expect(await dispatchToolCall(makeCtx({ config: deny }), makeState(), "message", { webhookUrl, body: "x" })).toBe(
        "Error: message sending disabled by policy (deny_bulk)."
      );
      const armed = makeState();
      armed.trifecta = { dataAccess: true, untrustedContent: true };
      const block = cfg({ security: { lethalTrifecta: { enabled: true, action: "block" } } });
      expect(await dispatchToolCall(makeCtx({ config: block }), armed, "message", { webhookUrl, body: "x" })).toBe(
        "Error: blocked by security policy (Lethal Trifecta)."
      );
      // The same armed turn may still send when the action is only "warn".
      vi.mocked(toolMessage).mockResolvedValue({ ok: true });
      const warn = cfg({ security: { lethalTrifecta: { enabled: true } } });
      expect(await dispatchToolCall(makeCtx({ config: warn }), armed, "message", { webhookUrl, body: "x" })).toBe("Sent.");
      expect(toolMessage).toHaveBeenCalledWith(warn, webhookUrl, "x");
    });
  });

  describe("sidebar", () => {
    const item = { id: "s1", label: "Next", action: "prompt", value: "go on" };

    it("sets the menu, flags the update and notifies the UI", async () => {
      const onSidebarUpdated = vi.fn();
      const state = makeState();
      const out = await dispatchToolCall(makeCtx({ onSidebarUpdated }), state, "sidebar_set", { title: "Next", items: [item] });
      expect(out).toContain("Sidebar set (1 items).");
      expect(state.sidebarUpdated).toBe(true);
      expect(onSidebarUpdated).toHaveBeenCalledTimes(1);
      const snapshot = JSON.parse(await dispatchToolCall(makeCtx(), state, "sidebar_get", {})) as {
        contextual: { items: unknown[] };
      };
      expect(snapshot.contextual.items).toEqual([expect.objectContaining({ id: "s1", label: "Next" })]);
      expect(await dispatchToolCall(makeCtx(), state, "sidebar_clear", {})).toContain("Sidebar cleared.");
    });

    it("does not flag an update when the store rejects the menu", async () => {
      const onSidebarUpdated = vi.fn();
      const state = makeState();
      const out = await dispatchToolCall(makeCtx({ onSidebarUpdated }), state, "sidebar_set", {
        items: Array.from({ length: 50 }, (_, i) => ({ ...item, id: `s${i}` })),
      });
      expect(out).toContain("Error:");
      expect(state.sidebarUpdated).toBe(false);
      expect(onSidebarUpdated).not.toHaveBeenCalled();
    });
  });

  describe("tasks and reminders", () => {
    it("maps the store results for tasks and reminders", async () => {
      vi.mocked(tasksAdd).mockReturnValue({ ok: true, id: 4 } as never);
      vi.mocked(tasksList).mockReturnValue([
        { id: 4, text: "Buy milk", done: false, importance: "medium", urgency: "high", createdAt: "c" },
      ] as never);
      vi.mocked(tasksDone).mockReturnValue({ ok: true } as never);
      vi.mocked(tasksDelete).mockReturnValue({ ok: false, error: "no such task" } as never);
      vi.mocked(reminderAdd).mockReturnValue({ ok: true, id: 2 } as never);
      vi.mocked(reminderList).mockReturnValue([
        { id: 2, taskId: 4, taskText: "Buy milk", type: "daily", runAt: "r" },
      ] as never);
      vi.mocked(reminderDelete).mockReturnValue({ ok: true } as never);
      const ctx = makeCtx();
      expect(await dispatchToolCall(ctx, makeState(), "tasks_add", { text: " Buy milk " })).toBe("Task #4 added.");
      expect(tasksAdd).toHaveBeenCalledWith({}, { text: "Buy milk", importance: undefined, urgency: undefined });
      expect(await dispatchToolCall(ctx, makeState(), "tasks_list", { status: "open" })).toBe(
        "#4 ○ Buy milk| importance:medium, urgency:high (c)"
      );
      expect(await dispatchToolCall(ctx, makeState(), "tasks_done", { id: 4 })).toBe("Task #4 marked completed.");
      expect(await dispatchToolCall(ctx, makeState(), "tasks_delete", { id: "9" })).toBe("Error: no such task");
      expect(await dispatchToolCall(ctx, makeState(), "reminder_add", { taskId: 4, type: "daily" })).toBe(
        "Reminder #2 added (task #4, daily)."
      );
      expect(await dispatchToolCall(ctx, makeState(), "reminder_list", {})).toBe("#2 task #4: Buy milk | daily → r");
      expect(await dispatchToolCall(ctx, makeState(), "reminder_delete", { id: 2 })).toBe("Reminder #2 deleted.");
    });
  });

  describe("skill authoring", () => {
    it("code_skill returns the candidates or a failure", async () => {
      vi.mocked(runCodeSkill).mockResolvedValue({ ok: true, message: '{"runId":"r1"}', runId: "r1" });
      expect(await dispatchToolCall(makeCtx(), makeState(), "code_skill", { script: "x.js", task: "do" })).toBe('{"runId":"r1"}');
      vi.mocked(runCodeSkill).mockResolvedValue({ ok: false, message: "bad name" });
      expect(await dispatchToolCall(makeCtx(), makeState(), "code_skill", {})).toBe("Error: bad name");
      vi.mocked(runCodeSkill).mockRejectedValue(new Error("boom"));
      expect(await dispatchToolCall(makeCtx(), makeState(), "code_skill", {})).toBe("code_skill failed: boom");
    });

    it("accept_skill and write_agent install a skill and notify", async () => {
      const onWriteAgent = vi.fn();
      const ctx = makeCtx({ onWriteAgent });
      vi.mocked(acceptSkill).mockReturnValue({ ok: true, message: "Saved agents/x.js" });
      const out = await dispatchToolCall(ctx, makeState(), "accept_skill", { runId: "r1", candidateIndex: 0, script: "x.js" });
      expect(out).toBe("Saved agents/x.js");
      expect(acceptSkill).toHaveBeenCalledWith({}, "r1", 0);
      expect(onWriteAgent).toHaveBeenLastCalledWith("x.js", true);
      vi.mocked(writeAgent).mockReturnValue({ ok: false, message: "no header" });
      expect(await dispatchToolCall(ctx, makeState(), "write_agent", { script: "y.js", content: "code" })).toBe("Error: no header");
      expect(writeAgent).toHaveBeenCalledWith({}, { script: "y.js", content: "code" });
      expect(onWriteAgent).toHaveBeenLastCalledWith("y.js", false);
    });
  });

  describe("media, telephony, secrets, room", () => {
    it("generate_image returns the cell to paste and remembers the success", async () => {
      vi.mocked(toolGenerateImage).mockResolvedValue({ ok: true, imageUrl: "/files/output/a.png", warning: "slow" });
      const state = makeState();
      const out = await dispatchToolCall(makeCtx(), state, "generate_image", { prompt: "cat" });
      expect(out).toBe(
        'Warning: slow\nImage generated successfully.\nFILE_URL=/files/output/a.png\nCopy this EXACT block into your reply (do not invent another filename):\n[CELL type="image"]/files/output/a.png[/CELL]'
      );
      expect(state.generateImageSucceeded).toBe(true);
      vi.mocked(toolGenerateImage).mockResolvedValue({ ok: false, error: "down" });
      expect(await dispatchToolCall(makeCtx(), makeState(), "generate_image", { prompt: "cat" })).toContain(
        "Error: down. Do NOT invent"
      );
    });

    it("phone_call asks for the telephony block before dialling", async () => {
      const injectTelephonyContext = vi.fn();
      vi.mocked(toolPhoneCall).mockResolvedValue({ content: '{"state":"idle"}' } as never);
      const out = await dispatchToolCall(makeCtx({ injectTelephonyContext }), makeState(), "phone_call", { action: "status" });
      expect(out).toBe('{"state":"idle"}');
      expect(injectTelephonyContext).toHaveBeenCalledTimes(1);
      expect(toolPhoneCall).toHaveBeenCalledWith({}, { action: "status" });
    });

    it("read_secret returns the value and registers it as sensitive", async () => {
      vi.mocked(toolReadSecret).mockReturnValue({ ok: true, value: "sk-live" });
      const state = makeState();
      expect(await dispatchToolCall(makeCtx(), state, "read_secret", { id: "KEY" })).toBe("sk-live");
      expect(state.sensitiveContents).toEqual(["sk-live"]);
      expect(state.trifecta.dataAccess).toBe(true);
      expect(await dispatchToolCall(makeCtx(), makeState(), "read_secret", {})).toBe("Error: read_secret requires id");
      vi.mocked(toolReadSecret).mockReturnValue({ ok: false, error: "not allowed" });
      expect(await dispatchToolCall(makeCtx(), makeState(), "read_secret", { id: "X" })).toBe("Error: not allowed");
    });

    it("room_history is untrusted room content; room_send posts", async () => {
      vi.mocked(toolRoomHistory).mockResolvedValue({ ok: true, content: "A: hi" });
      const state = makeState();
      expect(await dispatchToolCall(makeCtx(), state, "room_history", {})).toBe(
        "<<<EXT>>>\nSource: llm-room\n---\nA: hi\n<<</EXT>>>"
      );
      expect(state.trifecta.untrustedContent).toBe(true);
      vi.mocked(toolRoomSend).mockResolvedValue({ ok: true, messageId: "m9" });
      expect(await dispatchToolCall(makeCtx(), state, "room_send", { text: "hi" })).toBe("Posted to room (id m9).");
    });

    it("chronicle_remember records into the session chronicle", async () => {
      vi.mocked(appendModelChronicleEntry).mockResolvedValue({ ok: true, id: "c1" } as never);
      const ctx = makeCtx({ cacheId: "cache-x" });
      expect(await dispatchToolCall(ctx, makeState(), "chronicle_remember", { text: "anchor" })).toBe("Chronicle saved: c1");
      expect(appendModelChronicleEntry).toHaveBeenCalledWith(SESSION, "cache-x", "anchor", undefined, ctx.client, {});
      expect(await dispatchToolCall(makeCtx(), makeState(), "chronicle_search", {})).toBe("Error: chronicle_search requires query");
    });
  });
});
