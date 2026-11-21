// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Logging of natural selection of skills (agentSelection).
 * Always stderr prefixed with [agent-selection]; with audit.logPath - duplicates key events.
 */
import type { Claw2Config } from "../config/types.js";
import { auditLog, type AuditEventType } from "../audit/log.js";

export type SelectionLogEvent =
  | "pick"
  | "skip_pick"
  | "bootstrap"
  | "run"
  | "drop"
  | "winner"
  | "regen"
  | "regen_failed"
  | "version_added"
  | "temp_write_failed";

const AUDIT_MAP: Partial<Record<SelectionLogEvent, AuditEventType>> = {
  pick: "agent_selection_pick",
  skip_pick: "agent_selection_skip",
  run: "agent_selection_run",
  drop: "agent_selection_drop",
  winner: "agent_selection_winner",
  regen: "agent_selection_regen",
  version_added: "agent_selection_version_added",
};

function formatLine(event: SelectionLogEvent, details: Record<string, unknown>): string {
  const bits = Object.entries(details)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  return `[agent-selection] ${event}${bits.length ? " " + bits.join(" ") : ""}`;
}

/**
 * Selection log. Doesn't write entire version code (only ids/lengths/metrics).
 */
export function selectionLog(
  config: Claw2Config | null | undefined,
  event: SelectionLogEvent,
  details: Record<string, unknown> = {}
): void {
  const line = formatLine(event, details);
  console.error(line);
  if (!config) return;
  const auditType = AUDIT_MAP[event];
  if (!auditType) return;
  auditLog(config, {
    type: auditType,
    details: { ...details },
  });
}
