// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Hybrid routing for skills vs code-in-chat.
 * Hint/retry only for *creating a skill/agent in agents/* — never for “show me bubble sort”.
 */

/** Explicit ask to create/write a claw2 skill or agent script (agents/). */
const SKILL_CREATE_PHRASES = [
  "создай агента",
  "создай skill",
  "создай скилл",
  "создай навык",
  "новый агент",
  "новый скрипт в agents",
  "напиши агента",
  "напиши skill",
  "напиши скилл",
  "напиши навык",
  "добавь агента",
  "добавь skill",
  "добавь скилл",
  "write an agent",
  "create an agent",
  "create a skill",
  "write a skill",
  "new agent",
  "add an agent",
  "add a skill",
  "code_skill",
  "write_agent",
  "нужен агент",
  "хочу агента",
  "нужно создать агента",
  "сгенерируй агента",
  "реализуй агента",
  "сделай агента",
  "создай агент",
  "напиши агент",
  "сделай агент",
];

const CODE_PATTERNS = [
  /```(?:python|js|javascript|typescript|rust|go|json)?\s*\n/i,
  /\bdef\s+\w+\s*\(/,
  /\bfunction\s+\w+\s*\(/,
  /\b(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(/,
  /\bclass\s+\w+\s*(?:extends\s+\w+\s*)?\{/,
  /^\s*import\s+[\s\S]*?from\s+['"]/m,
];

/** True when the user explicitly asks to create a skill/agent (not “show code in chat”). */
export function shouldHintCode(userInput: string): boolean {
  if (!userInput || typeof userInput !== "string") return false;
  const lower = userInput.trim().toLowerCase();
  return SKILL_CREATE_PHRASES.some((phrase) => lower.includes(phrase.toLowerCase()));
}

/** @deprecated alias — same as shouldHintCode (skill-creation only). */
export function shouldRetryForSkillCreation(userInput: string): boolean {
  return shouldHintCode(userInput);
}

/** Hint: only when creating a skill; chat examples stay in the reply. */
export const CODE_HINT_SUFFIX =
  "\n\n[System: the user asked to create a skill/agent. Prefer an existing run_agent skill if one fits. code_skill/write_agent only with their explicit permission. If they only wanted to *see* example code, put it in the chat reply — do not refuse.]";

/** Level 2: model reply contains code without tool calls. */
export function looksLikeCode(content: string | null): boolean {
  if (!content || typeof content !== "string") return false;
  const trimmed = content.trim();
  if (trimmed.length < 80) return false;
  return CODE_PATTERNS.some((p) => p.test(trimmed));
}

/** Retry message (only when retryIfCodeWithoutTool is explicitly enabled + skill-create intent). */
export const CODE_REMINDER_MESSAGE =
  "If you were creating a skill/agent, call the appropriate tool (run_agent / code_skill / write_agent) after explicit permission. If the user only asked to see code in chat, keep that code in your reply — do not delete it and do not replace it with an acknowledgement.";
