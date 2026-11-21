// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * xAI Grok Voice Realtime adapter (OpenAI-compatible WS, server-side API key).
 */
import type { Claw2Config } from "../../config/types.js";
import {
  resolveSipRealtimeApiKey,
  resolveSipRealtimeBaseURL,
  resolveSipRealtimeModel,
  resolveSipRealtimeSampleRate,
  resolveSipRealtimeVoice,
} from "../../config/sip.js";
import {
  OpenAiStyleRealtimeProvider,
  type OpenAiStyleRealtimeOptions,
} from "./openai-style-ws.js";

export const XAI_REALTIME_DEFAULT_URL = "wss://api.x.ai/v1/realtime";
export const XAI_REALTIME_DEFAULT_MODEL = "grok-voice";
export const XAI_REALTIME_DEFAULT_VOICE = "Ara";

export interface XaiRealtimeOptions extends OpenAiStyleRealtimeOptions {
  apiKey: string;
}

export function buildXaiRealtimeUrl(opts: { model?: string; baseURL?: string }): string {
  const base = (opts.baseURL?.trim() || XAI_REALTIME_DEFAULT_URL).replace(/\/$/, "");
  const model = (opts.model?.trim() || XAI_REALTIME_DEFAULT_MODEL).trim();
  const u = new URL(base);
  u.searchParams.set("model", model);
  return u.toString();
}

export function buildXaiAuthHeaders(apiKey: string): Record<string, string> {
  const key = apiKey.trim();
  if (!key) throw new Error("xAI Realtime: apiKey is required");
  return {
    Authorization: `Bearer ${key}`,
  };
}

export class XaiRealtimeProvider extends OpenAiStyleRealtimeProvider {
  readonly id = "xai" as const;

  private readonly apiKey: string;

  constructor(opts: XaiRealtimeOptions) {
    super({
      ...opts,
      model: opts.model?.trim() || XAI_REALTIME_DEFAULT_MODEL,
      defaultVoice: XAI_REALTIME_DEFAULT_VOICE,
      baseURL: opts.baseURL?.trim() || XAI_REALTIME_DEFAULT_URL,
    });
    this.apiKey = opts.apiKey.trim();
    if (!this.apiKey) throw new Error("xAI Realtime: apiKey is required");
  }

  protected logTag(): string {
    return "sip/realtime/xai";
  }

  protected buildAuthHeaders(): Record<string, string> {
    return buildXaiAuthHeaders(this.apiKey);
  }

  protected buildConnectUrl(model: string): string {
    return buildXaiRealtimeUrl({ model, baseURL: this.baseURL });
  }
}

export function createXaiRealtimeFromConfig(
  config: Claw2Config,
  overrides?: Partial<XaiRealtimeOptions>
): XaiRealtimeProvider {
  const apiKey = (overrides?.apiKey ?? resolveSipRealtimeApiKey(config)).trim();
  if (!apiKey) {
    throw new Error("xAI Realtime: apiKey required (sip.realtime.apiKey)");
  }
  return new XaiRealtimeProvider({
    apiKey,
    model: overrides?.model ?? (resolveSipRealtimeModel(config) || undefined),
    voice: overrides?.voice ?? (resolveSipRealtimeVoice(config) || undefined),
    baseURL: overrides?.baseURL ?? (resolveSipRealtimeBaseURL(config) || undefined),
    sampleRate: overrides?.sampleRate ?? resolveSipRealtimeSampleRate(config),
    sipSampleRate: overrides?.sipSampleRate,
    silenceDurationMs: overrides?.silenceDurationMs,
    vadThreshold: overrides?.vadThreshold,
    createResponseOnConnect: overrides?.createResponseOnConnect,
    callId: overrides?.callId,
  });
}
