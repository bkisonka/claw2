import { randomBytes } from "node:crypto";
import type { PromptContext } from "./prompt-history.js";
import { releaseProvenance, type OriginTag } from "../security/origin.js";

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  /** Out-of-band provenance (security/origin.ts); absent = trusted user text. */
  origin?: OriginTag;
}

const sessions = new Map<string, SessionMessage[]>();
const promptContexts = new Map<string, PromptContext>();

export function getSessionHistory(sessionId: string): SessionMessage[] {
  return sessions.get(sessionId) ?? [];
}

export function appendToSession(
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  origin?: OriginTag
): void {
  let history = sessions.get(sessionId);
  if (!history) {
    history = [];
    sessions.set(sessionId, history);
  }
  history.push({ role, content, origin });
}

/** @deprecated UI/feed is no longer overwritten by resume; left for scrub and occasional resets.*/
export function replaceSessionHistory(sessionId: string, messages: SessionMessage[]): void {
  sessions.set(sessionId, [...messages]);
}

export function getSessionPromptContext(sessionId: string): PromptContext | null {
  const ctx = promptContexts.get(sessionId);
  if (!ctx?.summary?.trim() || !(ctx.coveredCount > 0)) return null;
  return { summary: ctx.summary, coveredCount: ctx.coveredCount };
}

export function setSessionPromptContext(sessionId: string, summary: string, coveredCount: number): void {
  if (!summary.trim() || coveredCount <= 0) {
    promptContexts.delete(sessionId);
    return;
  }
  promptContexts.set(sessionId, { summary: summary.trim(), coveredCount });
}

export function clearSessionPromptContext(sessionId: string): void {
  promptContexts.delete(sessionId);
}

/** Removes legacy process-local history and prompt compaction state for one session. */
export function releaseGatewaySession(sessionId: string): void {
  sessions.delete(sessionId);
  promptContexts.delete(sessionId);
  // Context gone → provenance resets (strictest-label inheritance no longer
  // has anything to inherit from).
  releaseProvenance(sessionId);
}

export function generateSessionId(): string {
  // Crypto-random: session ids surface in /files/ names, so they must not be
  // guessable (Math.random + timestamp was enumerable).
  return `sess_${Date.now().toString(36)}_${randomBytes(12).toString("hex")}`;
}
