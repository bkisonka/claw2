// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Parent/subagent skill coding: N parallel candidates, scoped read/write/edit,
 * static validation only, parent accepts via accept_skill.
 * No nested code_skill (depth 1 only).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import type OpenAI from "openai";
import type { Claw2Config } from "../config/types.js";
import { createClient, normalizeToolCalls } from "../core/llm.js";
import { resolveAgentsDir } from "../agents/paths.js";
import { writeAgent } from "../agents/write-agent.js";
import { validateSkillSource } from "../agents/skill-header.js";
import { throwIfAborted } from "../core/abort.js";

const MAX_SUB_ITERS = 8;
const CODE_PREVIEW_CHARS = 4000;
const PENDING_TTL_MS = 30 * 60 * 1000;

export interface CodeSkillCandidate {
  index: number;
  ok: boolean;
  code: string;
  error?: string;
}

export interface CodeSkillRun {
  runId: string;
  script: string;
  task: string;
  candidates: CodeSkillCandidate[];
  createdAt: number;
}

const pending = new Map<string, CodeSkillRun>();

function prunePending(): void {
  const now = Date.now();
  for (const [id, run] of pending) {
    if (now - run.createdAt > PENDING_TTL_MS) {
      pending.delete(id);
    }
  }
}

function safeScriptName(script: string): string | null {
  const s = script.trim();
  const withExt = s.endsWith(".js") ? s : `${s}.js`;
  const base = withExt.replace(/^.*[/\\]/, "");
  if (base !== withExt || base.includes("..") || base.length < 4) return null;
  if (base.startsWith(".")) return null;
  return base;
}

function relCandidatePath(runId: string, index: number, script: string): string {
  return `.code_skill/${runId}/${index}/${script}`;
}

function subagentTools(relPath: string): OpenAI.Chat.ChatCompletionTool[] {
  const only = `Only path allowed: ${relPath} (under agents/).`;
  return [
    {
      type: "function",
      function: {
        name: "read",
        description: `Read the skill file under edit. ${only}`,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: `Must be exactly "${relPath}"` },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write",
        description: `Write full file content for the skill. ${only}`,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: `Must be exactly "${relPath}"` },
            content: { type: "string", description: "Full JavaScript source" },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit",
        description: `Replace text in the skill file. ${only}`,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: `Must be exactly "${relPath}"` },
            searchText: { type: "string" },
            replaceText: { type: "string" },
          },
          required: ["path", "searchText", "replaceText"],
        },
      },
    },
  ];
}

function pathAllowed(pathArg: string, relPath: string): boolean {
  const n = pathArg.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  const want = relPath.replace(/\\/g, "/");
  const base = want.split("/").pop() ?? want;
  return n === want || n === `agents/${want}` || n === base;
}

async function chatWithCustomTools(
  client: OpenAI,
  config: Claw2Config,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  tools: OpenAI.Chat.ChatCompletionTool[],
  signal?: AbortSignal
): Promise<{ content: string | null; tool_calls?: OpenAI.Chat.ChatCompletionMessageToolCall[] }> {
  const model = config.llm?.model ?? "gpt-4o-mini";
  const maxTokens = config.llm?.maxTokens;
  const enableThinking = config.llm?.enableThinking;
  const completion = await client.chat.completions.create(
    {
      model,
      messages,
      tools,
      tool_choice: "auto",
      ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
      ...(enableThinking === false ? ({ enable_thinking: false } as Record<string, unknown>) : {}),
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    signal ? { signal } : undefined
  );
  const msg = completion.choices[0]?.message;
  const rawCalls = msg?.tool_calls;
  const tool_calls =
    rawCalls && rawCalls.length > 0 ? normalizeToolCalls(rawCalls as unknown[]) : undefined;
  return { content: msg?.content ?? null, tool_calls };
}

function checkCandidate(script: string, code: string): string | undefined {
  const header = validateSkillSource(script, code);
  if (!header.ok) return header.error;
  // Parse as ESM without loading imports or executing the draft.
  const syntax = spawnSync(process.execPath, ["--check", "--input-type=module"], {
    input: code,
    encoding: "utf-8",
    timeout: 5_000,
    env: {},
  });
  if (syntax.status !== 0) {
    return syntax.error?.message ?? (syntax.stderr.trim().slice(0, 2_500) || "Invalid JavaScript syntax.");
  }
}

async function runOneCandidate(
  config: Claw2Config,
  client: OpenAI,
  opts: {
    runId: string;
    index: number;
    script: string;
    task: string;
    baselineCode: string | null;
  },
  signal?: AbortSignal
): Promise<CodeSkillCandidate> {
  const relPath = relCandidatePath(opts.runId, opts.index, opts.script);
  // Drafts are never written into the skill runner's filesystem view.
  let code = opts.baselineCode ??
    `// Agent: stub\n` +
    `// Call: run_agent({script:${JSON.stringify(opts.script)}})\n` +
    `// In: no args (stub)\n` +
    `// Out: stdout JSON {ok:true}\n` +
    `console.log(JSON.stringify({ ok: true, script: ${JSON.stringify(opts.script)} }));\n`;

  const system = `You are a coding subagent (depth 1). Implement the skill script.
Rules:
- You may ONLY use tools read, write, edit on path "${relPath}" (nothing else).
- Do not call code_skill, write_agent, run_agent, or touch other files.
- ESM: import from "node:*"; for CommonJS packages use createRequire(import.meta.url).
- REQUIRED file header (exact keys, before any code):
  // Agent: <one-line purpose>
  // Call: run_agent({script:"${opts.script}", stdin:"…" and/or args:[…]})
  // In: <what stdin/args mean>
  // Out: <stdout contract, e.g. FILE_URL=/files/output/… or JSON>
- Without Call/In/Out the skill will be REJECTED on accept. Do not invent --help flags.
- When done, the file must contain complete runnable code. Prefer write with full content.
- No markdown fences in the file. No <think> in the file.`;

  const user = `Target script: ${opts.script}
Working path: ${relPath}

Task from parent:
${opts.task}

Include a complete Agent/Call/In/Out header so the parent model can call this skill via run_agent without guessing.

${opts.baselineCode ? "A baseline was copied into the working path; improve or rewrite as needed." : "New skill — write the full implementation."}`;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const tools = subagentTools(relPath);

  try {
    for (let iter = 0; iter < MAX_SUB_ITERS; iter++) {
      throwIfAborted(signal);
      const response = await chatWithCustomTools(client, config, messages, tools, signal);
      if (!response.tool_calls?.length) break;
      messages.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.tool_calls,
      });
      for (const tc of response.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function?.arguments ?? "{}");
        } catch {
          args = {};
        }
        const name = tc.function?.name ?? "";
        const pathArg = String(args.path ?? "");
        let content: string;
        if (!pathAllowed(pathArg, relPath)) {
          content = `Error: path not allowed. Use exactly "${relPath}".`;
        } else if (name === "read") {
          content = code;
        } else if (name === "write") {
          code = String(args.content ?? "");
          content = `Wrote ${relPath}`;
        } else if (name === "edit") {
          const search = String(args.searchText ?? "");
          const replace = String(args.replaceText ?? "");
          if (!search || !code.includes(search)) {
            content = "Error: searchText not found";
          } else {
            code = code.split(search).join(replace);
            content = `Edited ${relPath}`;
          }
        } else {
          content = `Error: tool "${name}" not allowed for subagent`;
        }
        messages.push({ role: "tool", tool_call_id: tc.id!, content });
      }
    }

    const error = checkCandidate(opts.script, code);
    return { index: opts.index, ok: error === undefined, code, error };
  } catch (err) {
    // A cancelled turn is not a failed candidate: let the abort reach the caller.
    throwIfAborted(signal);
    return {
      index: opts.index,
      ok: false,
      code,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runCodeSkill(
  config: Claw2Config,
  options: { script: string; task: string },
  signal?: AbortSignal
): Promise<{ ok: boolean; message: string; runId?: string }> {
  throwIfAborted(signal);
  prunePending();
  const script = safeScriptName(options.script);
  if (!script) {
    return { ok: false, message: "Invalid script name: must be a .js filename without path." };
  }
  const task = options.task.trim();
  if (!task) {
    return { ok: false, message: "task is required (what the skill should do)." };
  }

  const n = Math.max(1, Math.floor(config.coding?.maxSubagents ?? 3));
  const agentsDir = resolveAgentsDir(config);
  const finalPath = resolve(agentsDir, script);
  let baseline: string | null = null;
  if (existsSync(finalPath)) {
    try {
      baseline = readFileSync(finalPath, "utf-8");
    } catch {
      baseline = null;
    }
  }

  const runId = randomBytes(8).toString("hex");
  const client = createClient(config);

  const candidates = await Promise.all(
    Array.from({ length: n }, (_, index) =>
      runOneCandidate(
        config,
        client,
        {
          runId,
          index,
          script,
          task,
          baselineCode: baseline,
        },
        signal
      )
    )
  );

  const run: CodeSkillRun = {
    runId,
    script,
    task,
    candidates,
    createdAt: Date.now(),
  };
  pending.set(runId, run);

  const summaries = candidates.map((c) => {
    const preview =
      c.code.length > CODE_PREVIEW_CHARS ? `${c.code.slice(0, CODE_PREVIEW_CHARS)}\n…[truncated]` : c.code;
    return {
      index: c.index,
      ok: c.ok,
      error: c.error,
      executed: false,
      codePreview: preview,
    };
  });

  return {
    ok: true,
    runId,
    message: JSON.stringify(
      {
        runId,
        script,
        candidates: n,
        note: "Candidates were checked statically, not executed. Review them and call accept_skill(runId, candidateIndex) to install one that passed. Do not claim the skill was run.",
        results: summaries,
      },
      null,
      2
    ),
  };
}

export function acceptSkill(
  config: Claw2Config,
  runId: string,
  candidateIndex: number
): { ok: boolean; message: string } {
  prunePending();
  const run = pending.get(runId.trim());
  if (!run) {
    return { ok: false, message: `Unknown or expired runId: ${runId}` };
  }
  const c = run.candidates.find((x) => x.index === candidateIndex);
  if (!c) {
    return {
      ok: false,
      message: `No candidate index ${candidateIndex}. Valid: ${run.candidates.map((x) => x.index).join(", ")}`,
    };
  }
  if (!c.ok) {
    return { ok: false, message: c.error ?? "Candidate failed static validation." };
  }
  const result = writeAgent(config, { script: run.script, content: c.code });
  if (result.ok) {
    pending.delete(run.runId);
    return {
      ok: true,
      message: `${result.message}. Candidate #${candidateIndex} accepted (validated, not executed).`,
    };
  }
  return result;
}
