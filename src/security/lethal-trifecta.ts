// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Lethal Trifecta: heuristic (1) data access + (2) untrusted content + (3) outbound sending.
 * Called from the orchestrator before message is executed.
 */
import type { Claw2Config } from "../config/types.js";
import { auditLog } from "../audit/log.js";

const EXT_MARKER = "<<<EXT>>>";

/**
 * In-band marker scan — the BACKSTOP of the untrusted-content signal.
 * The primary signal is the out-of-band session ledger (security/origin.ts),
 * which survives summarization and cannot be forged by model-visible text;
 * the two are OR-ed in initTrifectaState (a false positive is the safe
 * direction).
 */
export function hasUntrustedInText(text: string): boolean {
  return text.includes(EXT_MARKER);
}

/**
 * Checks for Lethal Trifecta to work. If enabled and all three conditions are met, it writes to the audit and returns shouldBlock.
 */
export function checkLethalTrifecta(
  config: Claw2Config,
  state: { dataAccess: boolean; untrustedContent: boolean },
  sessionId?: string
): { trigger: boolean; shouldBlock: boolean } {
  const cfg = config.security?.lethalTrifecta;
  if (!cfg?.enabled) return { trigger: false, shouldBlock: false };
  if (!state.dataAccess || !state.untrustedContent) return { trigger: false, shouldBlock: false };
  // The third condition - the message call - is checked at the place of the call
  const action = cfg.action ?? "warn";
  auditLog(config, {
    type: "lethal_trifecta",
    sessionId,
    details: { action },
  });
  return { trigger: true, shouldBlock: action === "block" };
}
