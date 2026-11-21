// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * OpenAI Realtime adapter (server-side API key over WebSocket).
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

export const OPENAI_REALTIME_DEFAULT_URL = "wss://api.openai.com/v1/realtime";
export const OPENAI_REALTIME_DEFAULT_MODEL = "gpt-realtime";
export const OPENAI_REALTIME_DEFAULT_VOICE = "alloy";

export interface OpenAiRealtimeOptions extends OpenAiStyleRealtimeOptions {
  apiKey: string;
}

export function buildOpenAiRealtimeUrl(opts: { model?: string; baseURL?: string }): string {
  const base = (opts.baseURL?.trim() || OPENAI_REALTIME_DEFAULT_URL).replace(/\/$/, "");
  const model = (opts.model?.trim() || OPENAI_REALTIME_DEFAULT_MODEL).trim();
  const u = new URL(base);
  u.searchParams.set("model", model);
  return u.toString();
}

export function buildOpenAiAuthHeaders(apiKey: string): Record<string, string> {
  const key = apiKey.trim();
  if (!key) throw new Error("OpenAI Realtime: apiKey is required");
  return {
    Authorization: `Bearer ${key}`,
  };
}

export class OpenAiRealtimeProvider extends OpenAiStyleRealtimeProvider {
  readonly id = "openai" as const;

  private readonly apiKey: string;

  constructor(opts: OpenAiRealtimeOptions) {
    super({
      ...opts,
      model: opts.model?.trim() || OPENAI_REALTIME_DEFAULT_MODEL,
      defaultVoice: OPENAI_REALTIME_DEFAULT_VOICE,
      baseURL: opts.baseURL?.trim() || OPENAI_REALTIME_DEFAULT_URL,
    });
    this.apiKey = opts.apiKey.trim();
    if (!this.apiKey) throw new Error("OpenAI Realtime: apiKey is required");
  }

  protected logTag(): string {
    return "sip/realtime/openai";
  }

  protected buildAuthHeaders(): Record<string, string> {
    return buildOpenAiAuthHeaders(this.apiKey);
  }

  protected buildConnectUrl(model: string): string {
    return buildOpenAiRealtimeUrl({ model, baseURL: this.baseURL });
  }
}

export function createOpenAiRealtimeFromConfig(
  config: Claw2Config,
  overrides?: Partial<OpenAiRealtimeOptions>
): OpenAiRealtimeProvider {
  const apiKey = (overrides?.apiKey ?? resolveSipRealtimeApiKey(config)).trim();
  if (!apiKey) {
    throw new Error(
      "OpenAI Realtime: apiKey required (sip.realtime.apiKey or useLlmApiKey + llm.apiKey)"
    );
  }
  return new OpenAiRealtimeProvider({
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
