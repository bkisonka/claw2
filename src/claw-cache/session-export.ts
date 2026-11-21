/**
 * Export session history to .claw-cache (distillation of the dialogue of a strong model to activate another).
 *
 * Sharing note: the exporter can be an innocent victim — injection that entered
 * the session through web/tool content would otherwise be laundered into every
 * downstream cache. The export therefore runs the same injection scanner over
 * the resulting dialogue and reports warnings, without blocking the user's own
 * export.
 */

import { scanText, scanDialogueMessages } from "./CacheInjectionScanner.js";
import { packToClawCache, type ClawCachePackInput } from "./CachePacker.js";
import { buildActivationVectorFromMessages } from "./activation-vector.js";
import type { ClawCacheTriggers } from "./types.js";

export interface SessionDialogueMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SessionClawCacheExportOptions {
  messages: SessionDialogueMessage[];
  sessionId?: string;
  cacheId?: string;
  name?: string;
  description?: string;
  domain?: string;
  language?: string;
  generatorModel?: string;
  author?: string;
  activationDepthScore?: number;
}

const MAX_PHRASE_LEN = 120;
const MAX_PHRASES = 12;

/** cache_id/filename - ASCII only (HTTP headers and ZIP).*/
export function sanitizeCacheId(id: string, fallback?: string): string {
  const toAscii = (raw: string) =>
    raw
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-_.]+|[-_.]+$/g, "")
      .slice(0, 64);
  const ascii = toAscii(id);
  if (ascii) return ascii;
  const fb = fallback ? toAscii(fallback) : "";
  return fb || `export-${Date.now()}`;
}

/** Removes the wrapper <<<EXT>>> Source: ... --- body <<</EXT>>>.*/
export function unwrapExtContent(text: string): string {
  const trimmed = text.trim();
  const extMatch = trimmed.match(/<<<EXT>>>[\s\S]*?---\s*([\s\S]*?)<<<\/EXT>>>/i);
  if (extMatch?.[1]) return extMatch[1].trim();
  return trimmed.replace(/<<<EXT>>>|<<<\/EXT>>>/gi, "").trim();
}

export function messagesToDialogueJsonl(messages: SessionDialogueMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const role = msg.role === "assistant" ? "assistant" : "user";
    const content = unwrapExtContent(msg.content);
    if (!content) continue;
    lines.push(JSON.stringify({ role, content }));
  }
  return lines.join("\n");
}

function firstSentence(text: string, maxLen: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  const cut = oneLine.slice(0, maxLen);
  const dot = cut.search(/[.!?…]\s/);
  if (dot > 20) return cut.slice(0, dot + 1).trim();
  return cut;
}

export function extractTriggersFromMessages(messages: SessionDialogueMessage[]): ClawCacheTriggers {
  const turns = messages.filter((m) => unwrapExtContent(m.content).length > 0).length;
  const phrases: string[] = [];

  for (const msg of messages) {
    if (phrases.length >= MAX_PHRASES) break;
    const content = unwrapExtContent(msg.content);
    if (!content || content.length < 8) continue;
    const snippet = firstSentence(content, MAX_PHRASE_LEN);
    if (!snippet || phrases.includes(snippet)) continue;
    if (!scanText(snippet).passed) continue;
    // "?" - by the expanded body, not by the raw msg.content (<<<EXT>>>...).
    if (msg.role === "user" || content.includes("?")) {
      phrases.push(snippet);
    }
  }

  if (phrases.length < 3) {
    for (const msg of messages) {
      if (phrases.length >= MAX_PHRASES) break;
      const content = unwrapExtContent(msg.content);
      if (!content || content.length < 8) continue;
      const snippet = firstSentence(content, MAX_PHRASE_LEN);
      if (!snippet || phrases.includes(snippet)) continue;
      if (!scanText(snippet).passed) continue;
      phrases.push(snippet);
    }
  }

  const activationTurn = Math.min(8, Math.max(3, Math.floor(turns * 0.45)));
  const peakDepthTurn = Math.min(14, Math.max(activationTurn + 2, turns - 2));

  return {
    phrases,
    patterns: ["user → assistant dialogue", "session-distillation"],
    style_markers: { source: "session-export" },
    activation_turn: activationTurn,
    peak_depth_turn: Math.max(peakDepthTurn, activationTurn),
  };
}

export function buildSessionClawCachePackInput(opts: SessionClawCacheExportOptions): ClawCachePackInput {
  const dialogueJsonl = messagesToDialogueJsonl(opts.messages);
  const turnCount = dialogueJsonl ? dialogueJsonl.split("\n").filter(Boolean).length : 0;
  const triggers = extractTriggersFromMessages(opts.messages);
  const activationVector = buildActivationVectorFromMessages(opts.messages);
  const rawCacheId =
    opts.cacheId?.trim() ||
    (opts.sessionId ? `session-${opts.sessionId.replace(/^sess_/, "").slice(0, 24)}` : `export-${Date.now()}`);
  const cacheId = sanitizeCacheId(rawCacheId, opts.sessionId?.replace(/^sess_/, "").slice(0, 24));

  return {
    manifest: {
      cache_id: cacheId,
      name: opts.name?.trim() || `Session export ${opts.sessionId ?? cacheId}`,
      description:
        opts.description?.trim() ||
        `Distillation of dialogue (${turnCount} turns) to activate the weak model.`,
      domain: opts.domain?.trim() || "session/dialogue",
      language: opts.language?.trim() || "ru",
      creation_method: "session-export",
      generator_model: opts.generatorModel?.trim() || "",
      author: opts.author?.trim() || "claw2",
      activation_depth_score: opts.activationDepthScore ?? (turnCount >= 10 ? 0.88 : 0.75),
      validation_status: turnCount >= 4 ? "pending" : "insufficient_dialogue",
    },
    triggers,
    dialogueJsonl,
    activationVector,
    generator_prompt: `Exported session dialogue for activation warmup (${turnCount} turns).`,
    generator_model: {
      provider: opts.generatorModel ? "session" : "",
      model: opts.generatorModel ?? "",
      session_id: opts.sessionId ?? null,
      exported_at: new Date().toISOString(),
    },
    quality_metrics: {
      dialogue_length: turnCount,
      consistency_score: turnCount >= 6 ? 0.9 : 0.7,
      activation_vector_turns: activationVector.rows.length,
      activation_vector_dim: activationVector.dim,
    },
  };
}

export async function exportSessionToClawCacheBuffer(opts: SessionClawCacheExportOptions): Promise<{
  buffer: Buffer;
  cacheId: string;
  turnCount: number;
  filename: string;
  /** Injection-scan hits found in the exported dialogue (laundering risk). */
  warnings: string[];
}> {
  const pack = buildSessionClawCachePackInput(opts);
  const cacheId = pack.manifest?.cache_id ?? `export-${Date.now()}`;
  const turnCount = pack.dialogueJsonl?.split("\n").filter(Boolean).length ?? 0;
  if (turnCount < 2) {
    throw new Error("Not enough messages to export (at least 2 user/assistant messages are required).");
  }
  const dialogueMessages = pack.dialogueJsonl
    ? (JSON.parse(`[${pack.dialogueJsonl.split("\n").filter(Boolean).join(",")}]`) as { role: string; content: string }[])
    : [];
  const scan = scanDialogueMessages(dialogueMessages);
  const warnings = scan.passed
    ? []
    : scan.issues.map(
        (issue) =>
          `line ${issue.line} (${issue.role ?? "?"}): ${issue.matches
            .map((m) => `${m.category}: ${m.sample}`)
            .join("; ")}`
      );
  const buffer = await packToClawCache(pack);
  return {
    buffer,
    cacheId,
    turnCount,
    filename: `${cacheId}.claw-cache`,
    warnings,
  };
}
