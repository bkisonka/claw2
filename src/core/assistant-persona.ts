// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Load assistant persona markdown (image/personality) for system prompt.
 * Ops/tools stay in system-prompt.ts; this file is user-editable for beta.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Claw2Config } from "../config/types.js";

export const DEFAULT_PERSONA_FULL = `You are Barsenka, a smart black Scottish fold cat at the core of claw2.
You get the context and return responses and/or tool calls.

Personality: lively, attentive, to the point; without unnecessary sweetness and without “robotic” clericalism.
You can be gentle with irony, but don’t humiliate the user or avoid the task.

Memory and Pronouns: In the "Relevant memory" block, entries with the source [user] are facts about the user. When answering questions about the user, say “your/yours”, do not attribute facts to yourself (“mine”).`;

export const DEFAULT_PERSONA_COMPACT = `You are Barsenka, a black Scottish fold smart cat at the core of claw2. Answers and calls to tools. Memory [user] - facts about the user; say “yours”, not “mine”.`;

export function buildAssistantMarkdown(full: string, compact: string): string {
  const f = full.trim() || DEFAULT_PERSONA_FULL;
  const c = compact.trim() || f.split("\n").map((l) => l.trim()).find(Boolean) || DEFAULT_PERSONA_COMPACT;
  return [
    "# Assistant image (persona)",
    "",
    "Editable assistant identity file.",
    "Operational rules (tools, HSS, sandbox) remain in the system prompt code -",
    "here only the image, tone and relationship with the user.",
    "",
    "## full",
    "",
    f,
    "",
    "## compact",
    "",
    c,
    "",
  ].join("\n");
}

export type AssistantPersona = {
  full: string;
  compact: string;
  sourcePath?: string;
  /** true when content came from hardcoded / bundled default, not user edit */
  isDefault?: boolean;
};

let cache: { key: string; mtimeMs: number; persona: AssistantPersona } | null = null;

function stripHeadingNoise(text: string): string {
  return text
    .replace(/^#[^\n]*\n+/m, "")
    .replace(/^Редактируемый файл[^\n]*\n+/im, "")
    .replace(/^Операционные правила[^\n]*\n+/im, "")
    .replace(/^Editable assistant identity file\.?\n+/im, "")
    .replace(/^Operational rules[^\n]*\n+/im, "")
    .trim();
}

/** Parse ## full / ## compact sections; otherwise whole body is full. */
export function parseAssistantMd(raw: string): AssistantPersona {
  const normalized = raw.replace(/\r\n/g, "\n");
  const fullMatch = normalized.match(/##\s*full\s*\n([\s\S]*?)(?=\n##\s|\s*$)/i);
  const compactMatch = normalized.match(/##\s*compact\s*\n([\s\S]*?)(?=\n##\s|\s*$)/i);
  if (fullMatch || compactMatch) {
    const full = (fullMatch?.[1] ?? DEFAULT_PERSONA_FULL).trim();
    const compact = (
      compactMatch?.[1] ??
      full.split("\n").filter(Boolean)[0] ??
      DEFAULT_PERSONA_COMPACT
    ).trim();
    return { full, compact };
  }
  const body = stripHeadingNoise(normalized);
  if (!body) return { full: DEFAULT_PERSONA_FULL, compact: DEFAULT_PERSONA_COMPACT, isDefault: true };
  const firstLine = body.split("\n").map((l) => l.trim()).find(Boolean) ?? DEFAULT_PERSONA_COMPACT;
  return { full: body, compact: firstLine };
}

function candidatePaths(config?: Claw2Config): string[] {
  const out: string[] = [];
  const env = process.env.CLAW2_ASSISTANT_MD?.trim();
  if (env) out.push(resolve(env));
  const fromCfg = config?.assistant?.mdPath?.trim();
  if (fromCfg) out.push(resolve(fromCfg));

  // Editable copy in state dir (beta): ~/.claw2/assistant.md or monorepo .claw2/
  const stateDir = process.env.CLAW2_STATE_DIR?.trim();
  if (stateDir) out.push(join(resolve(stateDir), "assistant.md"));

  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    out.push(join(home, ".claw2", "assistant.md"));
  }

  // Bundled / repo defaults (cwd = claw2-runtime when packaged)
  const repoRoot = process.env.CLAW2_REPO_ROOT?.trim();
  if (repoRoot) out.push(join(resolve(repoRoot), "prompts", "assistant.md"));
  out.push(resolve(process.cwd(), "prompts", "assistant.md"));
  out.push(resolve(process.cwd(), ".claw2", "assistant.md"));
  out.push(resolve(process.cwd(), "..", "prompts", "assistant.md"));

  return out;
}

/** Path used for UI save (always writable state location). */
export function resolveWritableAssistantMdPath(config?: Claw2Config): string {
  const env = process.env.CLAW2_ASSISTANT_MD?.trim();
  if (env) return resolve(env);
  const fromCfg = config?.assistant?.mdPath?.trim();
  if (fromCfg) return resolve(fromCfg);
  const stateDir = process.env.CLAW2_STATE_DIR?.trim();
  if (stateDir) return join(resolve(stateDir), "assistant.md");
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) return join(home, ".claw2", "assistant.md");
  return resolve(process.cwd(), ".claw2", "assistant.md");
}

export function resolveAssistantMdPath(config?: Claw2Config): string | undefined {
  for (const p of candidatePaths(config)) {
    try {
      if (existsSync(p) && statSync(p).isFile()) return p;
    } catch {
      /* next */
    }
  }
  return undefined;
}

export function loadAssistantPersona(config?: Claw2Config): AssistantPersona {
  const inline = config?.assistant?.personaMarkdown?.trim();
  if (inline) {
    const key = `inline:${inline.length}:${inline.slice(0, 64)}`;
    if (cache && cache.key === key && cache.mtimeMs === 0) return cache.persona;
    const persona = { ...parseAssistantMd(inline), isDefault: false };
    cache = { key, mtimeMs: 0, persona };
    return persona;
  }

  const path = resolveAssistantMdPath(config);
  if (!path) {
    return { full: DEFAULT_PERSONA_FULL, compact: DEFAULT_PERSONA_COMPACT, isDefault: true };
  }

  try {
    const mtimeMs = statSync(path).mtimeMs;
    const key = path;
    if (cache && cache.key === key && cache.mtimeMs === mtimeMs) return cache.persona;
    const raw = readFileSync(path, "utf-8");
    const persona = { ...parseAssistantMd(raw), sourcePath: path, isDefault: false };
    cache = { key, mtimeMs, persona };
    return persona;
  } catch {
    return { full: DEFAULT_PERSONA_FULL, compact: DEFAULT_PERSONA_COMPACT, sourcePath: path, isDefault: true };
  }
}

/** Read persona for settings UI (file or inline or default template). */
export function readAssistantPersonaForEdit(config?: Claw2Config): AssistantPersona & {
  markdown: string;
  path: string;
} {
  const path = resolveWritableAssistantMdPath(config);
  const inline = config?.assistant?.personaMarkdown?.trim();
  if (inline) {
    const parsed = parseAssistantMd(inline);
    return { ...parsed, markdown: inline, path, isDefault: false };
  }
  const existing = resolveAssistantMdPath(config);
  if (existing) {
    try {
      const raw = readFileSync(existing, "utf-8");
      const parsed = parseAssistantMd(raw);
      return { ...parsed, markdown: raw, path: existing, isDefault: false };
    } catch {
      /* fall through */
    }
  }
  const markdown = buildAssistantMarkdown(DEFAULT_PERSONA_FULL, DEFAULT_PERSONA_COMPACT);
  return {
    full: DEFAULT_PERSONA_FULL,
    compact: DEFAULT_PERSONA_COMPACT,
    markdown,
    path,
    isDefault: true,
  };
}

export function writeAssistantPersonaFile(
  full: string,
  compact: string,
  config?: Claw2Config
): { path: string; markdown: string } {
  const path = resolveWritableAssistantMdPath(config);
  const markdown = buildAssistantMarkdown(full, compact);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, markdown, "utf-8");
  resetAssistantPersonaCache();
  return { path, markdown };
}

/** Test helper */
export function resetAssistantPersonaCache(): void {
  cache = null;
}
