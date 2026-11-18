/**
 * Lethal Trifecta: heuristic (1) data access + (2) untrusted content + (3) outbound sending.
 * Called from the orchestrator before message is executed.
 */
import type { Claw2Config } from "../config/types.js";
import { auditLog } from "../audit/log.js";

const EXT_MARKER = "<<<EXT>>>";

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
