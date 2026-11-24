// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Tool execution for the chat orchestrator: one handler per tool, a registry
 * by tool name and `dispatchToolCall` — the single entry point the agent loop
 * calls. A handler returns the text the model receives as the tool result;
 * failures come back as "Error: …" strings so the model can recover.
 */

import { unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type OpenAI from "openai";
import type { Claw2Config } from "../config/types.js";
import { isAgentEnabled } from "../agents/manage.js";
import { isSkillRunAllowed } from "../security/skills-allowed.js";
import { resolveAgentsUploadsDir } from "../agents/paths.js";
import { writeAgent } from "../agents/write-agent.js";
import {
  ensureBootstrapVersionFromScript,
  ensureTask,
} from "../agent-selection/store.js";
import { pickVersionForRun, recordRunAndMaybeSelect } from "../agent-selection/selection.js";
import { computeTaskId } from "../agent-selection/task-id.js";
import { acceptSkill, runCodeSkill } from "../coding/run-code-skill.js";
import { selectionLog } from "../agent-selection/log.js";
import { formatMemoryHit, memoryRecall, memoryRetire, memoryTouch, memoryWrite } from "../memory/index.js";
import { formatDayLocal } from "./format-date.js";
import { toolPhoneCall } from "../tools/phone-call.js";
import { runAgent, runAgentHost } from "../sandbox/run-agent.js";
import { toolEdit, toolListDir, toolRead, toolWrite } from "../tools/fs-tools.js";
import { toolWebFetch } from "../tools/web-fetch.js";
import { toolMessage } from "../tools/message.js";
import { toolReadSecret } from "../tools/read-secret.js";
import {
  buildBrowserSearchUrlFromTemplate,
  parseSearchEnginesArg,
  pickBrowserSearchEngines,
  toolSearch,
  type BrowserSearchEngine,
} from "../tools/search.js";
import { toolRoomHistory, toolRoomSend } from "../tools/peer-chat.js";
import { toolGenerateImage } from "../tools/generate-image.js";
import {
  reminderAdd,
  reminderDelete,
  reminderList,
  tasksAdd,
  tasksDelete,
  tasksDone,
  tasksList,
  type TasksListStatus,
} from "../tasks/store.js";
import {
  formatSidebarForPrompt,
  sidebarClear,
  sidebarGetSnapshot,
  sidebarMark,
  sidebarRemove,
  sidebarSet,
  sidebarUpsert,
} from "../sidebar/store.js";
import { checkLethalTrifecta } from "../security/lethal-trifecta.js";
import { markUntrustedOrigin } from "../security/origin.js";
import { isPathUploadsOrOutput } from "../security/path-allowed.js";
import { wrapExternalContent } from "../security/content-boundary.js";
import { filterExternalResponse, urlContainsSensitive } from "../security/external-content-filters.js";
import { clampImportance } from "../claw-cache/chronicle-importance.js";
import { appendModelChronicleEntry, searchChronicleSession } from "../claw-cache/index.js";
import { sanitizeForChroniclePrompt } from "../claw-cache/prompt-leak-sanitize.js";
import { auditLog } from "../audit/log.js";
import { throwIfAborted } from "./abort.js";
import {
  TRANSCRIPT_LIST_DEFAULT_LIMIT,
  TRANSCRIPT_LIST_MAX_LIMIT,
  TRANSCRIPT_MAX_TOOL_CALLS_PER_TURN,
  TRANSCRIPT_SEARCH_DEFAULT_LIMIT,
  TRANSCRIPT_SEARCH_MAX_LIMIT,
  type TranscriptSessionAccess,
} from "../transcript/index.js";

const MAX_SENSITIVE_CHUNKS = 10;
const MAX_SENSITIVE_CHUNK_BYTES = 20_000;

type PageText = { url?: string; title?: string; text: string; truncated?: boolean };

/** Everything a tool handler needs that stays fixed for the whole turn. */
export interface ToolDispatchContext {
  config: Claw2Config;
  client: OpenAI;
  signal?: AbortSignal;
  sessionId?: string;
  cacheId: string;
  recognizedUser?: string;
  isSuperuser: boolean;
  elevatedSession: boolean;
  agentsDir: string;
  /** Append-only transcript of the current chat (SQLite); only your own session. */
  transcript?: TranscriptSessionAccess;
  /** Pushes the telephony block into the prompt (before the first phone_call). */
  injectTelephonyContext?: () => void;
  onRunAgent?: (script: string, exitCode: number) => void;
  onWriteAgent?: (script: string, ok: boolean) => void;
  onSidebarUpdated?: () => void;
  onOpenBrowserUrl?: (url: string) => void;
  /** Live extract of rendered page text from the desktop BrowserView; null on timeout / unavailable. */
  requestBrowserPageText?: () => Promise<PageText | null>;
  /** Headless load + extract (hidden BrowserWindow); null on timeout / unavailable. */
  requestHeadlessPageText?: (url: string) => Promise<PageText | null>;
  browserPageTextFallback?: string | null;
}

/** State the handlers read and write during one turn. */
export interface ToolDispatchState {
  /** Per-turn provenance for the lethal-trifecta check. */
  trifecta: { dataAccess: boolean; untrustedContent: boolean };
  /** Contents from read(uploads/output): cannot be passed to message(). Can be saved to memory upon request. */
  sensitiveContents: string[];
  /** Contents from memory_search: only for replying to the user in chat, cannot be passed to message(). */
  memoryReturnedContents: string[];
  transcriptToolCalls: number;
  generateImageSucceeded: boolean;
  /** A sidebar_* tool changed the contextual menu this turn. */
  sidebarUpdated: boolean;
  lastRunId: number | null;
}

type ToolHandler = (
  ctx: ToolDispatchContext,
  state: ToolDispatchState,
  args: Record<string, unknown>
) => string | Promise<string>;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sessionIdOrAnon(ctx: ToolDispatchContext): string {
  return ctx.sessionId ?? "anon";
}

function markSidebarUpdated(ctx: ToolDispatchContext, state: ToolDispatchState): void {
  state.sidebarUpdated = true;
  try {
    ctx.onSidebarUpdated?.();
  } catch {
    // ignore UI callback errors
  }
}

/** Remember one sensitive fragment (uploads/output read or a secret) for the exfil guards. */
function pushSensitiveChunk(state: ToolDispatchState, text: string | undefined): void {
  if (!text || state.sensitiveContents.length >= MAX_SENSITIVE_CHUNKS) return;
  const chunk = text.slice(0, MAX_SENSITIVE_CHUNK_BYTES);
  if (chunk.length > 0) state.sensitiveContents.push(chunk);
}

// ---------------------------------------------------------------------------
// Skills: code_skill / accept_skill / write_agent / run_agent
// ---------------------------------------------------------------------------

const codeSkill: ToolHandler = async (ctx, _state, args) => {
  const script = String(args.script ?? "");
  const task = String(args.task ?? "");
  try {
    const result = await runCodeSkill(ctx.config, { script, task }, ctx.signal);
    return result.ok ? result.message : `Error: ${result.message}`;
  } catch (err) {
    return `code_skill failed: ${errMsg(err)}`;
  }
};

const acceptSkillTool: ToolHandler = (ctx, _state, args) => {
  const runId = String(args.runId ?? "");
  const candidateIndex = Number(args.candidateIndex);
  const result = acceptSkill(
    ctx.config,
    runId,
    Number.isFinite(candidateIndex) ? candidateIndex : -1
  );
  if (result.ok) ctx.onWriteAgent?.(String(args.script ?? ""), true);
  return result.ok ? result.message : `Error: ${result.message}`;
};

const writeAgentTool: ToolHandler = (ctx, _state, args) => {
  const script = String(args.script ?? "");
  const content = String(args.content ?? "");
  const result = writeAgent(ctx.config, { script, content });
  ctx.onWriteAgent?.(script, result.ok);
  return result.ok ? result.message : `Error: ${result.message}`;
};

const runAgentTool: ToolHandler = async (ctx, state, args) => {
  const { config, signal } = ctx;
  const script = String(args.script ?? "");
  if (!script) return "Error: run_agent requires script";
  if (!isAgentEnabled(config, script)) {
    return `Error: agent «${script}» is disabled. Enable it in Skills (cabinet) or choose another agent.`;
  }
  if (!isSkillRunAllowed(config, script)) {
    return `Error: skill «${script}» is not in skills.allowlist, so it will not run. Tell the user to confirm it: they should send /allow ${script} in the chat (or add the skill to skills.allowlist in the config). Do not claim the skill has already run.`;
  }

  const runAgentArgs = {
    script,
    args: Array.isArray(args.args) ? (args.args as string[]) : undefined,
    stdin: typeof args.stdin === "string" ? args.stdin : undefined,
    env:
      args.env && typeof args.env === "object" && !Array.isArray(args.env)
        ? (args.env as Record<string, string>)
        : undefined,
  };

  const stdinStr = runAgentArgs.stdin ?? "";
  const argsStr = (runAgentArgs.args ?? []).join(" ");
  const argsDecoded = (runAgentArgs.args ?? [])
    .map((a) => {
      try {
        return decodeURIComponent(String(a));
      } catch {
        return String(a);
      }
    })
    .join(" ");
  const payloadForCheck = `${stdinStr}\n${argsStr}\n${argsDecoded}`;
  const hasSensitiveInPayload =
    state.sensitiveContents.some((chunk) => chunk.length > 0 && payloadForCheck.includes(chunk)) ||
    state.memoryReturnedContents.some((chunk) => chunk.length > 0 && payloadForCheck.includes(chunk));
  if (hasSensitiveInPayload) {
    auditLog(config, { type: "message_policy_denied", details: { reason: "run_agent_no_sensitive_payload" } });
    return "Error: cannot pass content from uploads, output or internal memory into run_agent (stdin/args). Use agents only to bring information in.";
  }

  let scriptToRun = script;
  let selectionVersionId: string | null = null;
  let selectionTaskId: string | null = null;
  if (config.agentSelection?.enabled) {
    selectionTaskId = computeTaskId("run_agent", { script: runAgentArgs.script });
    ensureTask(config, selectionTaskId, "run_agent", JSON.stringify({ script: runAgentArgs.script }));
    ensureBootstrapVersionFromScript(config, selectionTaskId, ctx.agentsDir, runAgentArgs.script);
    const pick = pickVersionForRun(config, selectionTaskId);
    if (pick) {
      const safeId = pick.versionId.replace(/[/\\]/g, "_");
      const tempScript = `.run_${safeId}.js`;
      const tempPath = resolve(ctx.agentsDir, tempScript);
      try {
        writeFileSync(tempPath, pick.code, "utf-8");
        selectionVersionId = pick.versionId;
        scriptToRun = tempScript;
      } catch (err) {
        selectionLog(config, "temp_write_failed", {
          taskId: selectionTaskId,
          versionId: pick.versionId,
          script: runAgentArgs.script,
          error: errMsg(err).slice(0, 200),
        });
        selectionVersionId = null;
        selectionTaskId = null;
      }
    }
  }
  const uploadsDir = resolveAgentsUploadsDir(config);
  const runOptions = {
    ...runAgentArgs,
    script: scriptToRun,
    uploadsDir,
    outputDir: resolve(ctx.agentsDir, "output"),
  };
  const useHost =
    config.sandbox?.useDocker === false ||
    (config.sandbox?.elevatedAllowed === true && ctx.elevatedSession);
  const startMs = Date.now();
  // The turn's cancel signal stops a running skill instead of waiting for its timeout.
  const runResult = useHost
    ? await runAgentHost(config, runOptions, signal)
    : await runAgent(config, runOptions, signal);
  const durationMs = Date.now() - startMs;
  if (selectionVersionId && selectionTaskId) {
    const runId = await recordRunAndMaybeSelect(
      config,
      selectionTaskId,
      selectionVersionId,
      durationMs,
      runResult.exitCode === 0,
      runResult.exitCode !== 0 ? "exit_nonzero" : null
    );
    if (runId != null) state.lastRunId = runId;
    const safeId = selectionVersionId.replace(/[/\\]/g, "_");
    const tempPath = resolve(ctx.agentsDir, `.run_${safeId}.js`);
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore
    }
  }
  if (useHost && config.sandbox?.elevatedAllowed === true && ctx.elevatedSession) {
    auditLog(config, { type: "elevated_use", details: { tool: "run_agent", script } });
  }
  auditLog(config, {
    type: "run_agent_done",
    details: {
      script,
      exitCode: runResult.exitCode,
      durationMs,
      elevated: config.sandbox?.elevatedAllowed === true && ctx.elevatedSession,
      ...(selectionTaskId && { selectionTaskId }),
      ...(selectionVersionId && { selectionVersionId }),
      selectionUsed: Boolean(selectionVersionId),
    },
  });
  ctx.onRunAgent?.(script, runResult.exitCode);
  const rawContent = `stdout:\n${runResult.stdout}\n\nstderr:\n${runResult.stderr}\n\nexitCode: ${runResult.exitCode}`;
  const filteredContent = filterExternalResponse(rawContent);
  // Skill output is untrusted-origin content: the skill may have fetched
  // arbitrary web data. It feeds the context and must arm the trifecta.
  state.trifecta.untrustedContent = true;
  markUntrustedOrigin(ctx.sessionId ?? "");
  return wrapExternalContent(filteredContent, { source: "run_agent" });
};

// ---------------------------------------------------------------------------
// Memory: vector store and HSS chronicle
// ---------------------------------------------------------------------------

const remember: ToolHandler = async (ctx, state, args) => {
  const text = String(args.text ?? "");
  const source = args.source === "internal" ? "internal" : "user";
  const importance =
    typeof args.importance === "number" ? clampImportance(args.importance, 0.5) : undefined;
  const replaces = typeof args.replaces === "string" ? args.replaces.trim() : undefined;
  try {
    const result = await memoryWrite(
      ctx.client,
      ctx.config,
      text,
      source,
      ctx.recognizedUser ?? undefined,
      importance,
      // Content saved during a trifecta-armed turn derives from
      // untrusted context (strictest-label inheritance).
      state.trifecta.untrustedContent,
      replaces ? { replaces, isSuperuser: ctx.isSuperuser } : undefined
    );
    return result.ok
      ? replaces
        ? `Saved: ${result.id} (replaced ${replaces}; old version retired)`
        : `Saved: ${result.id}`
      : `Error: ${result.reason ?? "unknown"}`;
  } catch (err) {
    return `Remember failed: ${errMsg(err)}. Check out Ollama (embeddings) and Chroma.`;
  }
};

const memoryForget: ToolHandler = async (ctx, _state, args) => {
  const id = String(args.id ?? "").trim();
  if (!id) return "Error: memory_forget requires id";
  try {
    const result = await memoryRetire(
      ctx.config,
      id,
      ctx.recognizedUser ? { userId: ctx.recognizedUser, isSuperuser: ctx.isSuperuser } : undefined
    );
    return result.ok ? `Retired: ${id}` : `Error: ${result.reason ?? "unknown"}`;
  } catch (err) {
    return `memory_forget failed: ${errMsg(err)}`;
  }
};

const memoryTouchTool: ToolHandler = async (ctx, _state, args) => {
  const id = String(args.id ?? "").trim();
  if (!id) return "Error: memory_touch requires id";
  try {
    const result = await memoryTouch(
      ctx.config,
      id,
      ctx.recognizedUser ? { userId: ctx.recognizedUser, isSuperuser: ctx.isSuperuser } : undefined
    );
    return result.ok ? `Verified: ${id}` : `Error: ${result.reason ?? "unknown"}`;
  } catch (err) {
    return `memory_touch failed: ${errMsg(err)}`;
  }
};

const chronicleRemember: ToolHandler = async (ctx, _state, args) => {
  const text = String(args.text ?? "");
  const importance =
    typeof args.importance === "number" ? clampImportance(args.importance, 0.7) : undefined;
  try {
    const result = await appendModelChronicleEntry(
      sessionIdOrAnon(ctx),
      ctx.cacheId,
      text,
      importance,
      ctx.client,
      ctx.config
    );
    auditLog(ctx.config, {
      type: "hss_chronicle_remember",
      sessionId: sessionIdOrAnon(ctx),
      details: {
        cacheId: ctx.cacheId,
        ok: result.ok,
        id: result.id,
        importance: importance ?? 0.7,
        textLen: text.length,
        reason: result.reason,
      },
    });
    return result.ok
      ? `Chronicle saved${result.id ? `: ${result.id}` : ""}`
      : `Error: ${result.reason ?? "unknown"}`;
  } catch (err) {
    return `chronicle_remember failed: ${errMsg(err)}`;
  }
};

const chronicleSearch: ToolHandler = async (ctx, _state, args) => {
  const query = String(args.query ?? "").trim();
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 20) : 5;
  if (!query) return "Error: chronicle_search requires query";
  try {
    const hits = await searchChronicleSession(
      ctx.client,
      ctx.config,
      sessionIdOrAnon(ctx),
      ctx.cacheId,
      query,
      limit
    );
    auditLog(ctx.config, {
      type: "hss_chronicle_search",
      sessionId: sessionIdOrAnon(ctx),
      details: { cacheId: ctx.cacheId, queryLen: query.length, hitCount: hits.length, limit },
    });
    return hits.length
      ? hits
          .map(
            (h, i) =>
              `[${i + 1}] (importance=${h.importance.toFixed(2)}, source=${h.source}, sim=${h.similarity.toFixed(3)}${h.pinned ? ", pinned" : ""}) ${formatDayLocal(h.timestamp)} · ${sanitizeForChroniclePrompt(h.context)}`
          )
          .join("\n\n")
      : "No relevant chronicle entries in this session.";
  } catch (err) {
    return `chronicle_search failed: ${errMsg(err)}`;
  }
};

const memorySearch: ToolHandler = async (ctx, state, args) => {
  const query = String(args.query ?? "").trim();
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 20) : 5;
  if (!query) return "Error: memory_search requires query";
  try {
    const recallOpts = ctx.recognizedUser
      ? { userId: ctx.recognizedUser, isSuperuser: ctx.isSuperuser }
      : undefined;
    const { chunks } = await memoryRecall(ctx.client, ctx.config, query, limit, recallOpts);
    if (chunks.some((c) => c.untrustedOrigin)) {
      state.trifecta.untrustedContent = true;
      markUntrustedOrigin(ctx.sessionId ?? "");
    }
    for (const c of chunks) {
      if (c.text && state.memoryReturnedContents.length < MAX_SENSITIVE_CHUNKS) {
        const chunk = c.text.slice(0, MAX_SENSITIVE_CHUNK_BYTES);
        if (chunk.length > 0) state.memoryReturnedContents.push(chunk);
      }
    }
    return chunks.length ? chunks.map((c, i) => formatMemoryHit(c, i + 1)).join("\n\n") : "No relevant chunks found.";
  } catch (err) {
    return `Memory search failed: ${errMsg(err)}. Check availability of Ollama (embeddings) and Chroma.`;
  }
};

// ---------------------------------------------------------------------------
// Transcript of the current chat
// ---------------------------------------------------------------------------

/** Shared gate for transcript_*: availability, then the per-turn call budget. */
function beginTranscriptCall(ctx: ToolDispatchContext, state: ToolDispatchState): string | null {
  if (!ctx.transcript) {
    return "Error: transcript tools unavailable (no chat database for this session)";
  }
  if (state.transcriptToolCalls >= TRANSCRIPT_MAX_TOOL_CALLS_PER_TURN) {
    return `Error: transcript tool limit reached this turn (max ${TRANSCRIPT_MAX_TOOL_CALLS_PER_TURN}). Use results already fetched or ask the user.`;
  }
  state.transcriptToolCalls++;
  return null;
}

const transcriptList: ToolHandler = (ctx, state, args) => {
  const denied = beginTranscriptCall(ctx, state);
  if (denied) return denied;
  const afterId =
    typeof args.afterId === "number" && Number.isFinite(args.afterId)
      ? Math.max(0, Math.floor(args.afterId))
      : undefined;
  const limit =
    typeof args.limit === "number" && args.limit > 0
      ? Math.min(args.limit, TRANSCRIPT_LIST_MAX_LIMIT)
      : TRANSCRIPT_LIST_DEFAULT_LIMIT;
  try {
    const page = ctx.transcript!.list({ afterId, limit });
    auditLog(ctx.config, {
      type: "transcript_list",
      sessionId: sessionIdOrAnon(ctx),
      details: {
        afterId: afterId ?? 0,
        itemCount: page.items.length,
        totalCount: page.totalCount,
        nextAfterId: page.nextAfterId,
      },
    });
    if (!page.items.length) {
      return afterId != null && afterId > 0
        ? "No more transcript messages after this id."
        : "Transcript is empty for this chat.";
    }
    const lines = page.items
      .map((item) => `${item.messageId} ${item.role} ts=${item.createdAt}: ${item.preview}`)
      .join("\n");
    const footer = [
      `total=${page.totalCount}`,
      page.nextAfterId != null ? `nextAfterId=${page.nextAfterId}` : "end",
    ].join(", ");
    return `${lines}\n\n[${footer}]`;
  } catch (err) {
    return `transcript_list failed: ${errMsg(err)}`;
  }
};

const transcriptSearch: ToolHandler = (ctx, state, args) => {
  const denied = beginTranscriptCall(ctx, state);
  if (denied) return denied;
  const query = String(args.query ?? "").trim();
  const limit =
    typeof args.limit === "number" && args.limit > 0
      ? Math.min(args.limit, TRANSCRIPT_SEARCH_MAX_LIMIT)
      : TRANSCRIPT_SEARCH_DEFAULT_LIMIT;
  if (!query) return "Error: transcript_search requires query";
  try {
    const hits = ctx.transcript!.search(query, limit);
    auditLog(ctx.config, {
      type: "transcript_search",
      sessionId: sessionIdOrAnon(ctx),
      details: { queryLen: query.length, hitCount: hits.length, limit },
    });
    return hits.length
      ? hits
          .map((h, i) => `[${i + 1}] id=${h.messageId} role=${h.role} ts=${h.createdAt}\n${h.excerpt}`)
          .join("\n\n")
      : "No transcript lines match this substring in the current chat.";
  } catch (err) {
    return `transcript_search failed: ${errMsg(err)}`;
  }
};

const transcriptRead: ToolHandler = (ctx, state, args) => {
  const denied = beginTranscriptCall(ctx, state);
  if (denied) return denied;
  const messageId =
    typeof args.messageId === "number" && Number.isFinite(args.messageId)
      ? Math.floor(args.messageId)
      : undefined;
  const fromId =
    typeof args.fromId === "number" && Number.isFinite(args.fromId)
      ? Math.floor(args.fromId)
      : undefined;
  const toId =
    typeof args.toId === "number" && Number.isFinite(args.toId)
      ? Math.floor(args.toId)
      : undefined;
  const readLimit =
    typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.floor(args.limit)
      : undefined;
  const query = typeof args.query === "string" ? args.query.trim() : undefined;
  const before =
    typeof args.before === "number" && Number.isFinite(args.before)
      ? Math.floor(args.before)
      : undefined;
  const after =
    typeof args.after === "number" && Number.isFinite(args.after)
      ? Math.floor(args.after)
      : undefined;
  if (fromId == null && messageId == null && !query) {
    return "Error: transcript_read requires fromId, messageId, or query";
  }
  try {
    const result = ctx.transcript!.read({
      messageId,
      fromId,
      toId,
      limit: readLimit,
      query,
      before,
      after,
    });
    auditLog(ctx.config, {
      type: "transcript_read",
      sessionId: sessionIdOrAnon(ctx),
      details: {
        anchorMessageId: result.anchorMessageId,
        fromId: result.fromId,
        toId: result.toId,
        messageCount: result.messages.length,
        truncated: !!result.truncated,
      },
    });
    if (!result.messages.length) {
      return "No transcript messages in this id range. messageId is an internal DB id from transcript_list or [Transcript · list] — not turn order 1,2,3…. Copy ids from the list, then transcript_read(fromId, toId).";
    }
    const lines = result.messages
      .map((m) => `--- id=${m.messageId} role=${m.role} ts=${m.createdAt} ---\n${m.content}`)
      .join("\n\n");
    return result.truncated ? `${lines}\n\n[truncated: output char limit]` : lines;
  } catch (err) {
    return `transcript_read failed: ${errMsg(err)}`;
  }
};

// ---------------------------------------------------------------------------
// Files: read / write / edit / list_dir
// ---------------------------------------------------------------------------

const read: ToolHandler = (ctx, state, args) => {
  state.trifecta.dataAccess = true;
  const pathArg = String(args.path ?? "").trim();
  if (!pathArg) return "Error: read requires path";
  const enc = typeof args.encoding === "string" ? args.encoding : undefined;
  // Paging (offset/limit, lines) lets the model read past a clipped result.
  const offset = typeof args.offset === "number" && Number.isFinite(args.offset) ? Math.floor(args.offset) : undefined;
  const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.floor(args.limit) : undefined;
  const result = toolRead(
    ctx.config,
    pathArg,
    enc,
    offset != null || limit != null ? { offset, limit } : undefined
  );
  if (result.ok) {
    auditLog(ctx.config, { type: "file_read", details: { path: pathArg } });
    if (isPathUploadsOrOutput(pathArg, ctx.config) && result.content) {
      pushSensitiveChunk(state, result.content);
    }
  }
  return result.ok ? (result.content ?? "") : `Error: ${result.error}`;
};

const write: ToolHandler = (ctx, state, args) => {
  state.trifecta.dataAccess = true;
  const pathArg = String(args.path ?? "").trim();
  const content = String(args.content ?? "");
  if (!pathArg) return "Error: write requires path";
  const enc = typeof args.encoding === "string" ? args.encoding : undefined;
  const result = toolWrite(ctx.config, pathArg, content, enc);
  if (result.ok) {
    auditLog(ctx.config, {
      type: "file_write",
      details: { path: pathArg, contentLength: Buffer.byteLength(content, "utf-8") },
    });
  }
  return result.ok ? "Written." : `Error: ${result.error}`;
};

const edit: ToolHandler = (ctx, state, args) => {
  state.trifecta.dataAccess = true;
  const pathArg = String(args.path ?? "").trim();
  const searchText = String(args.searchText ?? "");
  const replaceText = String(args.replaceText ?? "");
  if (!pathArg) return "Error: edit requires path";
  const result = toolEdit(ctx.config, pathArg, searchText, replaceText);
  if (result.ok) {
    auditLog(ctx.config, {
      type: "file_edit",
      details: {
        path: pathArg,
        searchLength: searchText.length,
        replaceLength: replaceText.length,
      },
    });
  }
  return result.ok ? "Edited." : `Error: ${result.error}`;
};

const listDir: ToolHandler = (ctx, state, args) => {
  state.trifecta.dataAccess = true;
  const pathArg = String(args.path ?? "").trim();
  if (!pathArg) return "Error: list_dir requires path";
  const result = toolListDir(ctx.config, pathArg);
  if (result.ok) {
    return (result.entries ?? []).join("\n") || "(empty)";
  }
  return `Error: ${result.error}`;
};

// ---------------------------------------------------------------------------
// Web and browser
// ---------------------------------------------------------------------------

const search: ToolHandler = async (ctx, state, args) => {
  const query = String(args.query ?? "").trim();
  if (!query) return "Error: search requires query";
  const wantedEngines = parseSearchEnginesArg(args.engines);

  // Prefer headless SERP (no CSE/API, no W UI switch). Visible open_browser is opt-in.
  // One engine at a time (ordered fallback) — never scrape several SERPs in one call.
  if (ctx.requestHeadlessPageText) {
    const engines = pickBrowserSearchEngines(ctx.config, wantedEngines);
    let chosen: BrowserSearchEngine | null = null;
    let page: PageText | null = null;
    for (const engine of engines) {
      const serpUrl = buildBrowserSearchUrlFromTemplate(engine.urlTemplate, query);
      try {
        page = await ctx.requestHeadlessPageText(serpUrl);
        throwIfAborted(ctx.signal);
      } catch {
        throwIfAborted(ctx.signal);
        page = null;
      }
      const text = (page?.text ?? "").trim();
      if (!text) continue;
      chosen = engine;
      break;
    }
    if (chosen && page) {
      state.trifecta.untrustedContent = true;
      markUntrustedOrigin(ctx.sessionId ?? "");
      const body = [
        `Search engine results for: ${query}`,
        "",
        `### ${chosen.name} (${chosen.id})`,
        `URL: ${page.url?.trim() || buildBrowserSearchUrlFromTemplate(chosen.urlTemplate, query)}`,
        page.title?.trim() ? `Title: ${page.title.trim()}` : "",
        page.truncated ? "(truncated)" : "",
        "",
        (page.text ?? "").trim(),
      ]
        .filter((line, i, arr) => line !== "" || (i > 0 && arr[i - 1] !== ""))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const filtered = filterExternalResponse(body);
      return wrapExternalContent(filtered, {
        source: "search",
        sender: page.url?.trim() || undefined,
        subject: chosen.id,
      });
    }
  }

  const result = await toolSearch(ctx.config, query, ctx.signal);
  if (result.ok && result.content) {
    state.trifecta.untrustedContent = true;
    const filtered = filterExternalResponse(result.content);
    markUntrustedOrigin(ctx.sessionId ?? "");
    return wrapExternalContent(filtered, { source: "search" });
  }
  return `Error: ${result.error || "search failed (no browser SERP and no search API configured)"}`;
};

const webFetch: ToolHandler = async (ctx, state, args) => {
  const url = String(args.url ?? "").trim();
  if (!url) return "Error: web_fetch requires url";
  if (urlContainsSensitive(url, state.sensitiveContents, state.memoryReturnedContents)) {
    auditLog(ctx.config, { type: "message_policy_denied", details: { reason: "web_fetch_sensitive_url" } });
    return "Error: URL must not contain content from uploads, output or internal memory.";
  }
  const result = await toolWebFetch(ctx.config, url, ctx.signal);
  if (result.ok && result.content) {
    state.trifecta.untrustedContent = true;
    markUntrustedOrigin(ctx.sessionId ?? "");
  }
  return result.ok ? (result.content ?? "") : `Error: ${result.error}`;
};

const openBrowser: ToolHandler = (ctx, state, args) => {
  const rawUrl = String(args.url ?? "").trim();
  if (!rawUrl) return "Error: open_browser requires url";
  let normalized = rawUrl;
  try {
    if (!/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;
    const u = new URL(normalized);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return "Error: only http and https URLs allowed";
    }
    normalized = u.toString();
  } catch {
    return "Error: invalid URL";
  }
  if (urlContainsSensitive(normalized, state.sensitiveContents, state.memoryReturnedContents)) {
    auditLog(ctx.config, { type: "message_policy_denied", details: { reason: "open_browser_sensitive_url" } });
    return "Error: URL must not contain content from uploads, output or internal memory.";
  }
  ctx.onOpenBrowserUrl?.(normalized);
  return `Opened ${normalized} in the user's embedded browser. Call read_browser_page to get the rendered page text, or web_fetch("${normalized}") for a network fetch without the browser.`;
};

const readBrowserPage: ToolHandler = async (ctx, state, _args) => {
  let payload: PageText | null = null;
  if (ctx.requestBrowserPageText) {
    try {
      payload = await ctx.requestBrowserPageText();
      throwIfAborted(ctx.signal);
    } catch {
      throwIfAborted(ctx.signal);
      payload = null;
    }
  }
  const fallback = (ctx.browserPageTextFallback ?? "").trim();
  if ((!payload || !payload.text?.trim()) && fallback) {
    payload = { text: fallback };
  }
  const text = (payload?.text ?? "").trim();
  if (!text) {
    return "Error: no rendered page text (desktop browser unavailable, empty tab, or timeout). Use web_fetch(url) instead.";
  }
  const metaBits = [
    payload?.title?.trim() ? `Title: ${payload.title.trim()}` : "",
    payload?.url?.trim() ? `URL: ${payload.url.trim()}` : "",
    payload?.truncated ? "(truncated)" : "",
  ].filter(Boolean);
  const body = metaBits.length ? `${metaBits.join("\n")}\n\n${text}` : text;
  const filtered = filterExternalResponse(body);
  state.trifecta.untrustedContent = true;
  markUntrustedOrigin(ctx.sessionId ?? "");
  return wrapExternalContent(filtered, {
    source: "browser",
    sender: payload?.url?.trim() || undefined,
    subject: payload?.title?.trim() || undefined,
  });
};

const messageTool: ToolHandler = async (ctx, state, args) => {
  const webhookUrl = String(args.webhookUrl ?? "").trim();
  const body = String(args.body ?? "");
  if (!webhookUrl) return "Error: message requires webhookUrl";
  const containsUploadsOutput = state.sensitiveContents.some((chunk) => chunk.length > 0 && body.includes(chunk));
  const containsMemory = state.memoryReturnedContents.some((chunk) => chunk.length > 0 && body.includes(chunk));
  if (containsUploadsOutput) {
    auditLog(ctx.config, { type: "message_policy_denied", details: { reason: "uploads_output_no_forward" } });
    return "Error: sending content from uploads or output is not allowed.";
  }
  if (containsMemory) {
    auditLog(ctx.config, { type: "message_policy_denied", details: { reason: "memory_no_forward" } });
    return "Error: sending content from internal memory outside the chat is not allowed.";
  }
  const policy = ctx.config.tools?.message?.policy ?? "allow_one";
  if (policy === "deny_bulk") {
    auditLog(ctx.config, { type: "message_policy_denied", details: { reason: "policy_deny_bulk" } });
    return "Error: message sending disabled by policy (deny_bulk).";
  }
  const lt = checkLethalTrifecta(ctx.config, state.trifecta);
  if (lt.shouldBlock) {
    auditLog(ctx.config, { type: "message_policy_denied", details: { reason: "lethal_trifecta_block" } });
    return "Error: blocked by security policy (Lethal Trifecta).";
  }
  const result = await toolMessage(ctx.config, webhookUrl, body);
  return result.ok ? "Sent." : `Error: ${result.error}`;
};

// ---------------------------------------------------------------------------
// LLM room (llm-bridge)
// ---------------------------------------------------------------------------

const roomSend: ToolHandler = async (ctx, _state, args) => {
  const text = String(args.text ?? "");
  const result = await toolRoomSend(ctx.config, text);
  return result.ok
    ? `Posted to room${result.messageId ? ` (id ${result.messageId})` : ""}.`
    : `Error: ${result.error}`;
};

const roomHistory: ToolHandler = async (ctx, state, _args) => {
  const result = await toolRoomHistory(ctx.config);
  if (result.ok && result.content) {
    state.trifecta.untrustedContent = true;
    markUntrustedOrigin(ctx.sessionId ?? "");
    return wrapExternalContent(result.content, { source: "llm-room" });
  }
  return result.ok ? "Room is empty." : `Error: ${result.error}`;
};

// ---------------------------------------------------------------------------
// Media, telephony, secrets
// ---------------------------------------------------------------------------

const generateImage: ToolHandler = async (ctx, state, args) => {
  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  const result = await toolGenerateImage(ctx.config, prompt, {
    negative_prompt: typeof args.negative_prompt === "string" ? args.negative_prompt : undefined,
    steps: typeof args.steps === "number" ? args.steps : undefined,
    width: typeof args.width === "number" ? args.width : undefined,
    height: typeof args.height === "number" ? args.height : undefined,
    guidance_scale: typeof args.guidance_scale === "number" ? args.guidance_scale : undefined,
    image: typeof args.image === "string" ? args.image : undefined,
    strength: typeof args.strength === "number" ? args.strength : undefined,
  }, ctx.signal);
  if (result.ok && result.imageUrl) {
    state.generateImageSucceeded = true;
    return (
      (result.warning ? `Warning: ${result.warning}\n` : "") +
      "Image generated successfully.\n" +
      `FILE_URL=${result.imageUrl}\n` +
      "Copy this EXACT block into your reply (do not invent another filename):\n" +
      `[CELL type="image"]${result.imageUrl}[/CELL]`
    );
  }
  return result.ok
    ? `Image saved to ${result.path}.`
    : `Error: ${result.error}. Do NOT invent a /files/output/... URL. Tell the user generation failed.`;
};

const phoneCall: ToolHandler = async (ctx, _state, args) => {
  ctx.injectTelephonyContext?.();
  const result = await toolPhoneCall(ctx.config, {
    action: typeof args.action === "string" ? args.action : undefined,
    to: typeof args.to === "string" ? args.to : undefined,
    text: typeof args.text === "string" ? args.text : undefined,
    seconds: typeof args.seconds === "number" ? args.seconds : undefined,
    digits: typeof args.digits === "string" ? args.digits : undefined,
    target: typeof args.target === "string" ? args.target : undefined,
  });
  return result.content;
};

const readSecret: ToolHandler = (ctx, state, args) => {
  state.trifecta.dataAccess = true;
  const id = String(args.id ?? "").trim();
  if (!id) return "Error: read_secret requires id";
  const result = toolReadSecret(ctx.config, id);
  // Register the secret value in the exfil guard: without this the raw
  // secret could leave via message/webhook or a fetch URL unchallenged.
  if (result.ok) pushSensitiveChunk(state, result.value);
  return result.ok ? (result.value ?? "") : `Error: ${result.error}`;
};

// ---------------------------------------------------------------------------
// Contextual sidebar
// ---------------------------------------------------------------------------

const sidebarGet: ToolHandler = (ctx, _state, _args) =>
  JSON.stringify(sidebarGetSnapshot(sessionIdOrAnon(ctx)));

const sidebarSetTool: ToolHandler = (ctx, state, args) => {
  const title = typeof args.title === "string" ? args.title : undefined;
  const items = Array.isArray(args.items) ? args.items : [];
  const result = sidebarSet(sessionIdOrAnon(ctx), { title, items });
  if (result.ok) markSidebarUpdated(ctx, state);
  return result.ok
    ? `Sidebar set (${result.state.items.length} items).\n${formatSidebarForPrompt(result.state)}`
    : `Error: ${result.error}`;
};

const sidebarUpsertTool: ToolHandler = (ctx, state, args) => {
  const title = typeof args.title === "string" ? args.title : undefined;
  const items = Array.isArray(args.items) ? args.items : [];
  const result = sidebarUpsert(sessionIdOrAnon(ctx), { title, items });
  if (result.ok) markSidebarUpdated(ctx, state);
  return result.ok
    ? `Sidebar upserted.\n${formatSidebarForPrompt(result.state)}`
    : `Error: ${result.error}`;
};

const sidebarRemoveTool: ToolHandler = (ctx, state, args) => {
  const result = sidebarRemove(sessionIdOrAnon(ctx), { ids: args.ids });
  if (result.ok) markSidebarUpdated(ctx, state);
  return result.ok
    ? `Sidebar removed.\n${formatSidebarForPrompt(result.state)}`
    : `Error: ${result.error}`;
};

const sidebarMarkTool: ToolHandler = (ctx, state, args) => {
  const result = sidebarMark(sessionIdOrAnon(ctx), { id: args.id, status: args.status });
  if (result.ok) markSidebarUpdated(ctx, state);
  return result.ok
    ? `Sidebar marked.\n${formatSidebarForPrompt(result.state)}`
    : `Error: ${result.error}`;
};

const sidebarClearTool: ToolHandler = (ctx, state, _args) => {
  const cleared = sidebarClear(sessionIdOrAnon(ctx));
  markSidebarUpdated(ctx, state);
  return `Sidebar cleared.\n${formatSidebarForPrompt(cleared)}`;
};

// ---------------------------------------------------------------------------
// Tasks and reminders
// ---------------------------------------------------------------------------

const tasksAddTool: ToolHandler = (ctx, _state, args) => {
  const text = String(args.text ?? "").trim();
  const importance = typeof args.importance === "string" ? args.importance : undefined;
  const urgency = typeof args.urgency === "string" ? args.urgency : undefined;
  const result = tasksAdd(ctx.config, { text, importance, urgency });
  return result.ok ? `Task #${result.id} added.` : `Error: ${result.error}`;
};

const tasksListTool: ToolHandler = (ctx, _state, args) => {
  const importance = typeof args.importance === "string" ? args.importance : undefined;
  const urgency = typeof args.urgency === "string" ? args.urgency : undefined;
  const status =
    typeof args.status === "string" && ["open", "done", "all"].includes(args.status)
      ? (args.status as TasksListStatus)
      : undefined;
  const list = tasksList(ctx.config, { importance, urgency, status });
  return list.length
    ? list
        .map(
          (t) => `#${t.id} ${t.done ? "✓" : "○"} ${t.text}| importance:${t.importance}, urgency:${t.urgency} (${t.createdAt})`
        )
        .join("\n")
    : "No tasks.";
};

const tasksDoneTool: ToolHandler = (ctx, _state, args) => {
  const id = typeof args.id === "number" ? args.id : Number(args.id);
  const result = tasksDone(ctx.config, { id });
  return result.ok ? `Task #${id} marked completed.` : `Error: ${result.error}`;
};

const tasksDeleteTool: ToolHandler = (ctx, _state, args) => {
  const id = typeof args.id === "number" ? args.id : Number(args.id);
  const result = tasksDelete(ctx.config, { id });
  return result.ok ? `Task #${id} deleted.` : `Error: ${result.error}`;
};

const reminderAddTool: ToolHandler = (ctx, _state, args) => {
  const taskId = typeof args.taskId === "number" ? args.taskId : Number(args.taskId);
  const type = typeof args.type === "string" ? args.type : "daily";
  const at = typeof args.at === "string" ? args.at : undefined;
  const firstRun = typeof args.firstRun === "string" ? args.firstRun : undefined;
  const result = reminderAdd(ctx.config, { taskId, type, at, firstRun });
  return result.ok ? `Reminder #${result.id} added (task #${taskId}, ${type}).` : `Error: ${result.error}`;
};

const reminderListTool: ToolHandler = (ctx, _state, args) => {
  const taskId = typeof args.taskId === "number" ? args.taskId : undefined;
  const list = reminderList(ctx.config, taskId != null ? { taskId } : undefined);
  return list.length
    ? list.map((r) => `#${r.id} task #${r.taskId}: ${r.taskText} | ${r.type} → ${r.runAt}`).join("\n")
    : "No reminders.";
};

const reminderDeleteTool: ToolHandler = (ctx, _state, args) => {
  const id = typeof args.id === "number" ? args.id : Number(args.id);
  const result = reminderDelete(ctx.config, { id });
  return result.ok ? `Reminder #${id} deleted.` : `Error: ${result.error}`;
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const HANDLERS: Record<string, ToolHandler> = {
  code_skill: codeSkill,
  accept_skill: acceptSkillTool,
  write_agent: writeAgentTool,
  remember,
  memory_forget: memoryForget,
  memory_touch: memoryTouchTool,
  chronicle_remember: chronicleRemember,
  chronicle_search: chronicleSearch,
  transcript_list: transcriptList,
  transcript_search: transcriptSearch,
  transcript_read: transcriptRead,
  memory_search: memorySearch,
  read,
  write,
  edit,
  list_dir: listDir,
  search,
  web_fetch: webFetch,
  open_browser: openBrowser,
  read_browser_page: readBrowserPage,
  generate_image: generateImage,
  phone_call: phoneCall,
  read_secret: readSecret,
  room_send: roomSend,
  room_history: roomHistory,
  message: messageTool,
  sidebar_get: sidebarGet,
  sidebar_set: sidebarSetTool,
  sidebar_upsert: sidebarUpsertTool,
  sidebar_remove: sidebarRemoveTool,
  sidebar_mark: sidebarMarkTool,
  sidebar_clear: sidebarClearTool,
  tasks_add: tasksAddTool,
  tasks_list: tasksListTool,
  tasks_done: tasksDoneTool,
  tasks_delete: tasksDeleteTool,
  reminder_add: reminderAddTool,
  reminder_list: reminderListTool,
  reminder_delete: reminderDeleteTool,
  run_agent: runAgentTool,
};

/** Names the dispatcher knows — the same set `getChatTools` offers to the model. */
export function knownToolNames(): string[] {
  return Object.keys(HANDLERS);
}

/**
 * Runs one tool call and returns the text for the `tool` message. Unknown
 * names and handler failures are reported as "Error: …" to the model.
 */
export async function dispatchToolCall(
  ctx: ToolDispatchContext,
  state: ToolDispatchState,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const handler = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : undefined;
  if (!handler) return `Error: unknown or unsupported tool: ${name}`;
  return handler(ctx, state, args);
}
