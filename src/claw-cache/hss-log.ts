/**
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * HSS logging for debugging and comparing behavior before/after changes.
 * CLAW2_HSS_LOG=0 — off; 1 or unset — brief events; verbose — with context preview.
 * orchestrator.hssLogPath — also write to file (JSON by default).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Claw2Config } from "../config/types.js";

export type HssLogEvent =
  | "module_loaded"
  | "module_unavailable"
  | "node_cache_hit"
  | "node_created"
  | "chronicle_loaded"
  | "chronicle_persisted"
  | "chronicle_persist_skipped"
  | "chronicle_recall"
  | "chronicle_model_saved"
  | "evolve"
  | "evolve_skipped"
  | "prompt_hint"
  | "response_analysis"
  | "pending_hint"
  | "restored_from_chronicle"
  | "hss_retry"
  | "hss_retry_skipped"
  | "hss_retry_rejected_shrink"
  | "epistemic_hint"
  | "rho_dim_grown"
  | "expm_fallback"
  | "activation_vector_seeded";

function logLevel(): "off" | "normal" | "verbose" {
  const raw = (process.env.CLAW2_HSS_LOG ?? "1").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return "off";
  if (raw === "verbose" || raw === "debug") return "verbose";
  return "normal";
}

function previewText(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}…`;
}

function getLogPath(config?: Claw2Config): string | null {
  const path = config?.orchestrator?.hssLogPath?.trim();
  if (!path) return null;
  return resolve(path);
}

function formatFileLine(config: Claw2Config | undefined, payload: Record<string, unknown>): string {
  const format = config?.orchestrator?.hssLogFormat ?? "json";
  if (format === "json") return JSON.stringify(payload) + "\n";
  const sessionId = payload.sessionId ?? "-";
  return `${payload.ts}\t${payload.event}\t${sessionId}\t${JSON.stringify(payload)}\n`;
}

function appendHssLogFile(config: Claw2Config | undefined, payload: Record<string, unknown>): void {
  const path = getLogPath(config);
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, formatFileLine(config, payload), "utf-8");
  } catch (err) {
    console.error("[hss] failed to write log file:", err);
  }
}

export function hssLog(
  event: HssLogEvent,
  details: Record<string, unknown>,
  config?: Claw2Config
): void {
  const level = logLevel();
  if (level === "off") return;

  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    event,
    ...details,
  };

  if (level !== "verbose") {
    delete payload.contextPreview;
    delete payload.contextFull;
  }

  console.log(`[hss] ${event} ${JSON.stringify(payload)}`);
  appendHssLogFile(config, payload);
}

export function hssContextFields(context: string | undefined): {
  contextLen: number;
  contextPreview: string;
} {
  const text = context ?? "";
  return {
    contextLen: text.length,
    contextPreview: previewText(text),
  };
}
