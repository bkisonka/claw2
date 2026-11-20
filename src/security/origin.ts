/**
 * Content provenance (out-of-band taint tracking).
 *
 * The <<<EXT>>> text markers (content-boundary.ts) travel IN the channel —
 * they can be stripped by summarization/compaction or quoted innocently.
 * This module is the out-of-band counterpart: a per-session ledger recording
 * whether untrusted-origin content (web pages, search results, agent output,
 * other agents' messages) is part of the session context. The ledger lives
 * in session state, not in any string, so it survives summarization and
 * cannot be forged by model-visible text.
 *
 * Inheritance rule (strictest label wins): any derivative of untrusted
 * content — an assistant reply that used it, a history summary covering it —
 * keeps the session tainted. The ledger only ever flips to clean when the
 * session is released (its context is gone).
 *
 * Scope note: the in-band marker scan stays as a backstop (it catches paths
 * not yet instrumented); trifecta treats either signal as untrusted. PWA
 * engine parity is a follow-up (the PWA runs its own in-browser session
 * store).
 */

export type OriginSource =
  | "user"
  | "web"
  | "search"
  | "browser-page"
  | "run_agent"
  | "llm-room"
  | "channel"
  | "derived";

export interface OriginTag {
  source: OriginSource;
  /** true when the content came from outside the operator's own words. */
  untrusted: boolean;
  /** Where it came from (URL, channel id) when known; never model-visible here. */
  ref?: string;
}

/** Sessions that currently hold untrusted-origin content in their context. */
const taintedSessions = new Set<string>();

/** Mark a session's context as containing untrusted-origin content. */
export function markUntrustedOrigin(sessionId: string, tag?: OriginTag): void {
  if (!sessionId) return;
  taintedSessions.add(sessionId);
  if (tag && !tag.untrusted) return; // only untrusted tags taint; kept for call-site clarity
}

/** Whether the session context currently includes untrusted-origin content. */
export function hasUntrustedOrigin(sessionId: string): boolean {
  return taintedSessions.has(sessionId);
}

/** Session context is gone (released/scrubbed) — provenance resets. */
export function releaseProvenance(sessionId: string): void {
  taintedSessions.delete(sessionId);
}

/** Test hook: drop all ledger state. */
export function resetProvenanceForTest(): void {
  taintedSessions.clear();
}

/**
 * Initial trifecta state for a turn: provenance from the session ledger plus
 * the in-band marker scan of the user message (backstop for uninstrumented
 * paths and quoted-marker edge cases — a false positive is the safe
 * direction, so the signals are OR-ed).
 */
export function initTrifectaState(
  sessionId: string | undefined,
  fullUserMessage: string,
  hasUntrustedInText: (text: string) => boolean
): { dataAccess: boolean; untrustedContent: boolean } {
  const untrusted =
    (sessionId ? hasUntrustedOrigin(sessionId) : false) || hasUntrustedInText(fullUserMessage);
  return { dataAccess: false, untrustedContent: untrusted };
}
