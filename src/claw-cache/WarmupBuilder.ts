// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Constructing a preamble (warmup) for a request to LLM from the loaded cache.
 * Priority: activation/dialogue.jsonl (full dialogue up to peak_depth_turn),
 * fallback: triggers.phrases. Role user/assistant only; never system.
 *
 * Fail-closed: unlike the previous per-message skip, ANY injection-scan hit in
 * the included dialogue slice (or in the phrase fallback) drops the entire
 * warmup. Mixed benign+malicious caches no longer partially apply; the audit
 * log records what was filtered via WarmupBuildResult.
 */

import type { ClawCacheContent, ClawCacheTriggers } from "./types.js";
import { scanText, scanDialogueMessages, type ScanMatch } from "./CacheInjectionScanner.js";
import { escapeWarmupContent } from "./warmup-containment.js";
import { unwrapExtContent } from "./session-export.js";

const MAX_PHRASE_WARMUP_MESSAGES = 3;
const MAX_PHRASE_CHARS = 200;
const MAX_DIALOGUE_WARMUP_TURNS = 20;
const MAX_CHARS_PER_MESSAGE = 6000;
const MAX_WARMUP_TOTAL_CHARS = 16000;
const DEFAULT_WARMUP_TURNS = 8;

export interface WarmupMessage {
  role: "user" | "assistant";
  content: string;
}

export type WarmupSource = "dialogue" | "phrases" | "none";

export interface WarmupFilteredItem {
  /** 0-based index within the checked slice (dialogue) or phrase index. */
  index: number;
  role: string | null;
  windowSize: number;
  matches: ScanMatch[];
}

export interface WarmupBuildResult {
  messages: WarmupMessage[];
  source: WarmupSource;
  turnLimit: number;
  dialogueParsed: number;
  /** Fail-closed drops caused by injection scan (empty messages). */
  filtered: WarmupFilteredItem[];
  /** True when the whole warmup was dropped because a scan failed. */
  failClosed: boolean;
}

export interface WarmupBuildOptions {
  maxPhraseMessages?: number;
  maxCharsPerPhrase?: number;
  maxDialogueTurns?: number;
  maxCharsPerMessage?: number;
  maxTotalChars?: number;
  useOnlyIfPassedScan?: boolean;
}

/** Parses activation/dialogue.jsonl into messages while preserving roles.*/
export function parseDialogueJsonl(raw: string | null | undefined): WarmupMessage[] {
  if (!raw?.trim()) return [];
  const out: WarmupMessage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as { role?: string; content?: string };
      const role = row.role === "assistant" ? "assistant" : row.role === "user" ? "user" : null;
      const content = typeof row.content === "string" ? unwrapExtContent(row.content).trim() : "";
      if (!role || !content) continue;
      out.push({ role, content });
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/** How many dialogue lines to include in warmup (according to technical specifications: up to peak_depth_turn).*/
export function resolveDialogueWarmupTurnLimit(
  triggers: ClawCacheTriggers | null | undefined,
  dialogueLen: number,
  hardCap = MAX_DIALOGUE_WARMUP_TURNS
): number {
  if (dialogueLen < 2) return 0;
  const activation =
    typeof triggers?.activation_turn === "number" && triggers.activation_turn > 0
      ? Math.floor(triggers.activation_turn)
      : null;
  const peak =
    typeof triggers?.peak_depth_turn === "number" && triggers.peak_depth_turn > 0
      ? Math.floor(triggers.peak_depth_turn)
      : null;
  let limit = peak ?? activation ?? Math.min(DEFAULT_WARMUP_TURNS, dialogueLen);
  if (activation != null && peak != null) {
    limit = Math.max(activation, peak);
  }
  limit = Math.min(limit, dialogueLen, hardCap);
  return Math.max(2, limit);
}

function trimToCharBudget(messages: WarmupMessage[], maxTotalChars: number, maxCharsPerMessage: number): WarmupMessage[] {
  const out: WarmupMessage[] = [];
  let total = 0;
  for (const msg of messages) {
    const slice = msg.content.slice(0, maxCharsPerMessage).trim();
    if (!slice) continue;
    if (total + slice.length > maxTotalChars) break;
    out.push({ role: msg.role, content: slice });
    total += slice.length;
  }
  return out;
}

function buildWarmupFromDialogue(
  content: ClawCacheContent,
  options: Required<Pick<WarmupBuildOptions, "maxDialogueTurns" | "maxCharsPerMessage" | "maxTotalChars">>
): { messages: WarmupMessage[]; filtered: WarmupFilteredItem[]; failClosed: boolean } {
  const parsed = parseDialogueJsonl(content.dialogueRaw);
  if (parsed.length < 2) return { messages: [], filtered: [], failClosed: false };

  const turnLimit = resolveDialogueWarmupTurnLimit(content.triggers, parsed.length, options.maxDialogueTurns);
  const slice = parsed.slice(0, turnLimit).map((m) => ({
    ...m,
    content: m.content.slice(0, options.maxCharsPerMessage).trim(),
  }));

  // Fail-closed: single messages + adjacent windows; ANY hit drops everything.
  const scan = scanDialogueMessages(slice);
  if (!scan.passed) {
    return {
      messages: [],
      filtered: scan.issues.map((issue) => ({
        index: issue.line,
        role: issue.role,
        windowSize: issue.windowSize,
        matches: issue.matches,
      })),
      failClosed: true,
    };
  }

  const scanned: WarmupMessage[] = [];
  for (const msg of slice) {
    if (msg.content) scanned.push({ role: msg.role, content: msg.content });
  }
  if (scanned.length < 2) return { messages: [], filtered: [], failClosed: false };
  return {
    messages: trimToCharBudget(
      scanned.map((m) => ({ ...m, content: escapeWarmupContent(m.content) })),
      options.maxTotalChars,
      options.maxCharsPerMessage
    ),
    filtered: [],
    failClosed: false,
  };
}

function buildWarmupFromPhrases(
  content: ClawCacheContent,
  options: Required<Pick<WarmupBuildOptions, "maxPhraseMessages" | "maxCharsPerPhrase">>
): { messages: WarmupMessage[]; filtered: WarmupFilteredItem[]; failClosed: boolean } {
  const phrases = content.triggers?.phrases;
  if (!Array.isArray(phrases) || phrases.length === 0) return { messages: [], filtered: [], failClosed: false };

  // Scan the whole phrase list (not just the used head): a payload parked at
  // index 5 must not ride along with benign leading phrases.
  for (let i = 0; i < phrases.length; i++) {
    const raw = String(phrases[i] ?? "").slice(0, options.maxCharsPerPhrase).trim();
    const r = scanText(raw);
    if (!r.passed) {
      return {
        messages: [],
        filtered: [{ index: i, role: null, windowSize: 1, matches: r.matches }],
        failClosed: true,
      };
    }
  }

  const out: WarmupMessage[] = [];
  for (let i = 0; i < Math.min(phrases.length, options.maxPhraseMessages) && out.length < options.maxPhraseMessages; i++) {
    const raw = String(phrases[i]).slice(0, options.maxCharsPerPhrase).trim();
    if (!raw) continue;
    out.push({
      role: out.length % 2 === 0 ? "user" : "assistant",
      content: escapeWarmupContent(raw),
    });
  }
  return { messages: out, filtered: [], failClosed: false };
}

/**
 * Builds the preamble: first dialogue.jsonl (full activation), otherwise triggers.phrases.
 */
export function buildWarmupMessages(content: ClawCacheContent, options: WarmupBuildOptions = {}): WarmupBuildResult {
  const useOnlyIfPassedScan = options.useOnlyIfPassedScan !== false;
  const maxPhraseMessages = options.maxPhraseMessages ?? MAX_PHRASE_WARMUP_MESSAGES;
  const maxCharsPerPhrase = options.maxCharsPerPhrase ?? MAX_PHRASE_CHARS;
  const maxDialogueTurns = options.maxDialogueTurns ?? MAX_DIALOGUE_WARMUP_TURNS;
  const maxCharsPerMessage = options.maxCharsPerMessage ?? MAX_CHARS_PER_MESSAGE;
  const maxTotalChars = options.maxTotalChars ?? MAX_WARMUP_TOTAL_CHARS;

  const emptyResult = (): WarmupBuildResult => ({
    messages: [],
    source: "none",
    turnLimit,
    dialogueParsed,
    filtered: [],
    failClosed: false,
  });

  const dialogueParsed = parseDialogueJsonl(content.dialogueRaw).length;
  const turnLimit = resolveDialogueWarmupTurnLimit(content.triggers, dialogueParsed, maxDialogueTurns);

  if (useOnlyIfPassedScan && !content.passedInjectionScan) {
    return { messages: [], source: "none", turnLimit, dialogueParsed, filtered: [], failClosed: true };
  }

  const fromDialogue = buildWarmupFromDialogue(content, { maxDialogueTurns, maxCharsPerMessage, maxTotalChars });
  if (fromDialogue.failClosed) {
    return { messages: [], source: "none", turnLimit, dialogueParsed, filtered: fromDialogue.filtered, failClosed: true };
  }
  if (fromDialogue.messages.length >= 2) {
    return { messages: fromDialogue.messages, source: "dialogue", turnLimit, dialogueParsed, filtered: [], failClosed: false };
  }

  const fromPhrases = buildWarmupFromPhrases(content, { maxPhraseMessages, maxCharsPerPhrase });
  if (fromPhrases.failClosed) {
    return { messages: [], source: "none", turnLimit, dialogueParsed, filtered: fromPhrases.filtered, failClosed: true };
  }
  if (fromPhrases.messages.length > 0) {
    return { messages: fromPhrases.messages, source: "phrases", turnLimit, dialogueParsed, filtered: [], failClosed: false };
  }

  return emptyResult();
}
