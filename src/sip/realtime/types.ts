// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Shared types for SIP Realtime speech-to-speech adapters.
 */
import type { SipRealtimeProvider } from "../../config/types.js";

/** Flat Realtime function tool (OpenAI / Yandex / xAI session.update shape). */
export interface RealtimeToolDefinition {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface RealtimeToolCall {
  /** Provider call id (may equal name on some Yandex responses). */
  callId: string;
  name: string;
  /** Parsed object when JSON; otherwise raw string. */
  arguments: Record<string, unknown> | string;
}

export interface RealtimeSessionOptions {
  instructions?: string;
  tools?: RealtimeToolDefinition[];
  voice?: string;
  model?: string;
  /**
   * Provider PCM rate (Hz). Default depends on adapter (often 24000).
   * SIP side stays {@link SIP_PCM_RATE} (8000) unless overridden.
   */
  sampleRate?: number;
  /** SIP / RTP PCM rate (Hz). Default 8000. */
  sipSampleRate?: number;
  /** Optional greeting hint folded into instructions by the adapter. */
  greeting?: string;
}

export type RealtimeProviderId = Extract<SipRealtimeProvider, "yandex" | "openai" | "xai">;

export type RealtimeProviderEvents = {
  /** Downlink PCM already resampled to SIP rate (mono PCM16 LE). */
  audio: [pcmSip: Buffer];
  tool_call: [call: RealtimeToolCall];
  ready: [];
  closed: [];
  error: [err: Error];
  /** First downlink audio after connect (ms since connect). */
  ttfa: [ms: number];
};

export const DEFAULT_REALTIME_PROVIDER_RATE = 24_000;
