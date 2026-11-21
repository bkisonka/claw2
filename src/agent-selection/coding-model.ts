// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Encoder model: generating agent code with context from the database (dropped / winner).
 * A separate model, tailored for coding.
 */
import OpenAI from "openai";
import type { Claw2Config } from "../config/types.js";
import { buildContextMarkdown } from "./context-markdown.js";
import { normalizeOpenAIBaseURL } from "../core/llm.js";
import { selectionLog } from "./log.js";
import { PiiMasker, shouldApplyPrivacyForBaseURL } from "../privacy/index.js";

function createCodingClient(config: Claw2Config): OpenAI | null {
  const coding = config.agentSelection?.codingModel;
  if (!coding?.model) return null;
  const apiKey =
    coding.apiKey?.trim() || process.env.OPENAI_API_KEY || process.env.CLAW2_CODING_API_KEY || "ollama";
  // An empty apiKey is acceptable for local LM Studio (same endpoint as llm)
  return new OpenAI({
    apiKey,
    baseURL: normalizeOpenAIBaseURL(coding.baseURL?.trim() || config.llm?.baseURL),
  });
}

const SYSTEM_PROMPT_GENERATE = `You are a coding model. Generate a single Node.js agent script for the agents/ directory.

Requirements:
- Script must be runnable with: node script.js [args...]
- Use only Node.js built-ins or dependencies from the project's package.json.
- REQUIRED header before code (catalog for run_agent):
  // Agent: <one-line purpose>
  // Call: run_agent({script:"name.js", stdin:"…" and/or args:[…]})
  // In: <inputs>
  // Out: <stdout / FILE_URL=…>
- Output only the JavaScript code. No markdown code fences. No <think>, no reasoning, no commentary — only runnable code.

Module format (critical): The agents/ package has "type": "module" (ESM). Top-level require() will throw at runtime. Do not use it. Do not claim that \"require is safer\" or \"ESM needs .mjs\" — here all .js files are ESM.
- Node built-ins: always use import from "node:XXX". Examples: import { readFileSync } from "node:fs"; import https from "node:https"; import { URL } from "node:url". Never require('fs'), require('https'), require('url'), etc.
- CommonJS packages only (pdf-parse, mammoth, xlsx): use createRequire: const require = createRequire(import.meta.url); const lib = require("package-name");
- Output only code. No explanatory text about \"updated to ESM\" or \"compatibility\" in the file.`;

const SYSTEM_PROMPT_EDIT = `You are a coding model. You will receive the current agent script and a requested change. Apply the change and output the full modified script.

Rules:
- Output only the complete JavaScript code. No markdown fences, no <think>, no commentary.
- Preserve ESM format (import from "node:...", createRequire for CommonJS). Do not break the script.
- Keep or add the full usage header: // Agent / // Call / // In / // Out
- If the request is unclear, make a minimal safe change that matches the intent.`;

/**
 * Generate agent code for a task with context from the database (dropped versions and winner).
 * If currentCode is passed, the encoder edits the existing script (apply edits), otherwise it generates from scratch.
 * Returns code or null if there is no encoder-model config or there is an error.
 */
export async function generateAgentCode(
  config: Claw2Config,
  taskId: string,
  taskDescription: string,
  currentCode?: string
): Promise<string | null> {
  const client = createCodingClient(config);
  if (!client) return null;

  const contextMarkdown = buildContextMarkdown(config, taskId, taskDescription);
  const hasCurrent = typeof currentCode === "string" && currentCode.trim().length > 0;
  const systemPrompt = hasCurrent ? SYSTEM_PROMPT_EDIT : SYSTEM_PROMPT_GENERATE;

  const userParts = [
    `## Task ID: ${taskId}\n\n${taskDescription}`,
    `## Context from previous versions (avoid dropped approaches, prefer winner style):\n\n${contextMarkdown}`,
  ];
  if (hasCurrent) {
    userParts.push(
      `## Current script (apply the requested changes; output the full modified script):\n\n\`\`\`js\n${currentCode.trim()}\n\`\`\``
    );
  }
  userParts.push(hasCurrent ? "\nApply the changes and output the full JavaScript code only:" : "\nGenerate the agent JavaScript code only:");
  const userContent = userParts.join("\n\n");

  const codingBase =
    config.agentSelection?.codingModel?.baseURL?.trim() || config.llm?.baseURL;
  const privacyDecision = shouldApplyPrivacyForBaseURL(config, codingBase);
  const masker = privacyDecision.apply ? new PiiMasker(config.privacy?.customRules) : null;
  const outboundUser = masker ? masker.maskText(userContent) : userContent;

  try {
    const model = config.agentSelection?.codingModel?.model ?? "gpt-4o-mini";
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: outboundUser },
      ],
      max_tokens: 4096,
    });
    const raw = completion.choices[0]?.message?.content?.trim();
    if (!raw) return null;
    const restored = masker ? masker.unmaskText(raw) : raw;
    const code = restored.replace(/^```(?:js|javascript)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    return code || null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    selectionLog(config, "regen_failed", {
      taskId,
      reason: "coding_model_error",
      error: msg.slice(0, 200),
    });
    return null;
  } finally {
    masker?.clear();
  }
}
