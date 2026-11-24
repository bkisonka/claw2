// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Audit log of sensitive events (stage 4).
 * Events: memory_denied, lethal_trifecta, elevated_use, secret_access, message_policy_denied, file_read, file_write, file_edit.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Claw2Config } from "../config/types.js";

export type AuditEventType =
  | "memory_denied"
  | "lethal_trifecta"
  | "elevated_use"
  | "secret_access"
  | "secret_denied"
  | "message_policy_denied"
  | "file_read"
  | "file_write"
  | "file_edit"
  | "tool_iteration"
  | "tool_limit_reached"
  | "tool_limit_final_retry"
  | "tool_repeated_failure"
  | "tool_fruitless_steps"
  | "chat_turn"
  | "chat_cancelled"
  | "chat_gateway_restart"
  | "run_agent_done"
  | "memory_write"
  | "memory_retire"
  | "memory_touch"
  | "config_saved"
  | "config_saved_denied"
  | "agent_created"
  | "agent_deleted"
  | "restart_requested"
  | "context_summarized"
  | "context_summarize_attempt"
  | "context_summarize_failed"
  | "code_routing_reminder"
  | "image_routing_reminder"
  | "hss_evolve"
  | "hss_response_analysis"
  | "hss_critical_retry"
  | "hss_critical_retry_rejected_shrink"
  | "hss_epistemic_hint"
  | "cache_warmup_applied"
  | "cache_warmup_skipped"
  | "privacy_mask_applied"
  | "privacy_mask_skipped"
  | "privacy_multimodal_blocked"
  | "hss_chronicle_recall"
  | "hss_chronicle_remember"
  | "hss_chronicle_search"
  | "transcript_list_prefetch"
  | "transcript_list"
  | "transcript_search"
  | "transcript_read"
  | "call_start"
  | "call_media_backend"
  | "call_realtime_ttfa"
  | "call_realtime_fallback"
  | "agent_selection_pick"
  | "agent_selection_skip"
  | "agent_selection_run"
  | "agent_selection_drop"
  | "agent_selection_winner"
  | "agent_selection_regen"
  | "agent_selection_version_added"
  | "insight_offered"
  | "insight_accepted"
  | "insight_dismissed"
  | "vision_claim_rejected"
  | "egress_blocked";

export interface AuditEvent {
  type: AuditEventType;
  sessionId?: string;
  details?: Record<string, unknown>;
}

function getLogPath(config: Claw2Config): string | null {
  const path = config.audit?.logPath?.trim();
  if (!path) return null;
  return resolve(path);
}

function formatLine(config: Claw2Config, event: AuditEvent): string {
  const timestamp = new Date().toISOString();
  const payload = {
    ts: timestamp,
    event: event.type,
    ...(event.sessionId && { sessionId: event.sessionId }),
    ...(event.details && { details: event.details }),
  };
  if (config.audit?.logFormat === "json") {
    return JSON.stringify(payload) + "\n";
  }
  return `${timestamp}\t${event.type}\t${event.sessionId ?? "-"}\t${JSON.stringify(event.details ?? {})}\n`;
}

/**
 * Record the event in the audit log. If audit.logPath is not specified, it does nothing.
 */
export function auditLog(config: Claw2Config, event: AuditEvent): void {
  const path = getLogPath(config);
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, formatLine(config, event), "utf-8");
  } catch (err) {
    console.error("[audit] failed to write log:", err);
  }
}
