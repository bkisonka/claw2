// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Call media observability: call-logs + optional audit (no PCM / no speech text).
 */
import type { Claw2Config } from "../config/types.js";
import { auditLog, type AuditEventType } from "../audit/log.js";
import { appendCallLogEvent, type CallLogEventType } from "./call-log.js";
import { resolveSipMediaBackend } from "./media-backend.js";
import { resolveSipRealtimeProvider } from "../config/sip.js";

export type CallObserveInput = {
  callId: string;
  logId: string;
  direction: "in" | "out";
};

function auditSafe(
  config: Claw2Config | null | undefined,
  type: AuditEventType,
  callId: string,
  details: Record<string, unknown>
): void {
  if (!config) return;
  auditLog(config, { type, sessionId: callId, details });
}

/** call_start + media_backend (requested/effective). No remote URI in audit. */
export function observeCallStart(
  config: Claw2Config | null | undefined,
  call: CallObserveInput,
  opts?: { mediaEffective?: "node" | "sidecar" }
): void {
  const media = config
    ? resolveSipMediaBackend(config)
    : { requested: "auto" as const, backend: "node" as const, reason: "no config" };
  const effective = opts?.mediaEffective ?? media.backend;
  const provider = config ? resolveSipRealtimeProvider(config) : "off";

  appendCallLogEvent(call.logId, {
    type: "call_start",
    detail: `direction=${call.direction} realtime=${provider}`,
  });
  appendCallLogEvent(call.logId, {
    type: "media_backend",
    detail: `requested=${media.requested} effective=${effective} ${media.reason}`,
  });

  auditSafe(config, "call_start", call.callId, {
    direction: call.direction,
    realtimeProvider: provider,
  });
  auditSafe(config, "call_media_backend", call.callId, {
    requested: media.requested,
    effective,
    reason: media.reason,
    hasSidecarPath: Boolean(media.sidecarPath),
  });
}

export function observeRealtimeStarted(
  config: Claw2Config | null | undefined,
  call: CallObserveInput,
  providerId: string
): void {
  appendCallLogEvent(call.logId, {
    type: "realtime",
    detail: `provider=${providerId}`,
  });
}

export function observeRealtimeTtfa(
  config: Claw2Config | null | undefined,
  call: CallObserveInput,
  ms: number,
  providerId: string
): void {
  appendCallLogEvent(call.logId, {
    type: "realtime_ttfa",
    detail: `realtime_ttfa_ms=${ms} provider=${providerId}`,
  });
  auditSafe(config, "call_realtime_ttfa", call.callId, {
    ttfaMs: ms,
    provider: providerId,
  });
}

export function observeRealtimeFallback(
  config: Claw2Config | null | undefined,
  call: CallObserveInput,
  providerName: string,
  message: string
): void {
  appendCallLogEvent(call.logId, {
    type: "fallback",
    text: message,
    detail: `realtime_fallback:${providerName}`,
  });
  auditSafe(config, "call_realtime_fallback", call.callId, {
    provider: providerName,
    // Truncate error text; never include audio
    error: message.slice(0, 200),
  });
}

/** Re-export for typing convenience. */
export type { CallLogEventType };
