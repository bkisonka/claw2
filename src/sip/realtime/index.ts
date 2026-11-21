// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * SIP Realtime layer: provider contract + PCM resample (8 kHz ↔ provider rate).
 */
export type { RealtimeProvider } from "./provider.js";
export { BaseRealtimeProvider } from "./base.js";
export { OpenAiStyleRealtimeProvider } from "./openai-style-ws.js";
export type { OpenAiStyleRealtimeOptions } from "./openai-style-ws.js";
export {
  DEFAULT_REALTIME_PROVIDER_RATE,
  SIP_PCM_RATE,
  providerPcmToSip,
  sipPcmToProvider,
} from "./resample.js";
export type {
  RealtimeProviderEvents,
  RealtimeProviderId,
  RealtimeSessionOptions,
  RealtimeToolCall,
  RealtimeToolDefinition,
} from "./types.js";
export {
  YANDEX_REALTIME_DEFAULT_MODEL,
  YANDEX_REALTIME_DEFAULT_URL,
  YANDEX_REALTIME_DEFAULT_VOICE,
  YandexRealtimeProvider,
  buildYandexAuthHeaders,
  buildYandexModelUri,
  buildYandexRealtimeUrl,
  createYandexRealtimeFromConfig,
} from "./yandex.js";
export type { YandexRealtimeAuth, YandexRealtimeOptions } from "./yandex.js";
export {
  OPENAI_REALTIME_DEFAULT_MODEL,
  OPENAI_REALTIME_DEFAULT_URL,
  OPENAI_REALTIME_DEFAULT_VOICE,
  OpenAiRealtimeProvider,
  buildOpenAiAuthHeaders,
  buildOpenAiRealtimeUrl,
  createOpenAiRealtimeFromConfig,
} from "./openai.js";
export type { OpenAiRealtimeOptions } from "./openai.js";
export {
  XAI_REALTIME_DEFAULT_MODEL,
  XAI_REALTIME_DEFAULT_URL,
  XAI_REALTIME_DEFAULT_VOICE,
  XaiRealtimeProvider,
  buildXaiAuthHeaders,
  buildXaiRealtimeUrl,
  createXaiRealtimeFromConfig,
} from "./xai.js";
export type { XaiRealtimeOptions } from "./xai.js";
export { createRealtimeProviderFromConfig } from "./factory.js";
export {
  chatToolToRealtimeDefinition,
  compactRealtimeToolOutput,
  executeRealtimeToolCall,
  getRealtimeToolDefinitions,
  wireRealtimeTools,
} from "./tools.js";
export type { RealtimeToolsContext } from "./tools.js";
