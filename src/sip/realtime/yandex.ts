// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Yandex Speech Realtime adapter (OpenAI-compatible WS events).
 * Ref: rag2 SIP-client/sip_client/realtime/yandex_bridge.py
 */
import type { Claw2Config } from "../../config/types.js";
import {
  resolveSipRealtimeApiKey,
  resolveSipRealtimeBaseURL,
  resolveSipRealtimeFolderId,
  resolveSipRealtimeIamToken,
  resolveSipRealtimeModel,
  resolveSipRealtimeSampleRate,
  resolveSipRealtimeVoice,
} from "../../config/sip.js";
import {
  OpenAiStyleRealtimeProvider,
  type OpenAiStyleRealtimeOptions,
} from "./openai-style-ws.js";

export const YANDEX_REALTIME_DEFAULT_URL = "wss://ai.api.cloud.yandex.net/v1/realtime";
export const YANDEX_REALTIME_DEFAULT_MODEL = "speech-realtime-260528";
export const YANDEX_REALTIME_DEFAULT_VOICE = "alena";

export interface YandexRealtimeAuth {
  folderId: string;
  apiKey?: string;
  iamToken?: string;
}

export interface YandexRealtimeOptions extends YandexRealtimeAuth, OpenAiStyleRealtimeOptions {}

export function buildYandexModelUri(folderId: string, model?: string): string {
  const m = (model?.trim() || YANDEX_REALTIME_DEFAULT_MODEL).trim();
  if (m.startsWith("gpt://")) return m.replaceAll("{folder}", folderId);
  return `gpt://${folderId}/${m}/latest`;
}

export function buildYandexRealtimeUrl(opts: {
  folderId: string;
  model?: string;
  baseURL?: string;
}): string {
  const base = (opts.baseURL?.trim() || YANDEX_REALTIME_DEFAULT_URL).replace(/\/$/, "");
  const modelUri = buildYandexModelUri(opts.folderId, opts.model);
  const u = new URL(base);
  u.searchParams.set("model", modelUri);
  return u.toString();
}

export function buildYandexAuthHeaders(auth: YandexRealtimeAuth): Record<string, string> {
  const folderId = auth.folderId.trim();
  if (!folderId) throw new Error("Yandex Realtime: folderId is required");
  const apiKey = auth.apiKey?.trim() || "";
  const iam = auth.iamToken?.trim() || "";
  let authorization: string;
  if (apiKey) authorization = `Api-Key ${apiKey}`;
  else if (iam) authorization = `Bearer ${iam}`;
  else throw new Error("Yandex Realtime: set apiKey or iamToken");
  return {
    Authorization: authorization,
    "OpenAI-Project": folderId,
    "x-folder-id": folderId,
  };
}

export class YandexRealtimeProvider extends OpenAiStyleRealtimeProvider {
  readonly id = "yandex" as const;

  private readonly folderId: string;
  private readonly apiKey?: string;
  private readonly iamToken?: string;

  constructor(opts: YandexRealtimeOptions) {
    super({
      ...opts,
      model: opts.model?.trim() || YANDEX_REALTIME_DEFAULT_MODEL,
      defaultVoice: YANDEX_REALTIME_DEFAULT_VOICE,
      baseURL: opts.baseURL?.trim() || YANDEX_REALTIME_DEFAULT_URL,
    });
    this.folderId = opts.folderId.trim();
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.iamToken = opts.iamToken?.trim() || undefined;
    if (!this.folderId) throw new Error("Yandex Realtime: folderId is required");
  }

  protected logTag(): string {
    return "sip/realtime/yandex";
  }

  protected buildAuthHeaders(): Record<string, string> {
    return buildYandexAuthHeaders({
      folderId: this.folderId,
      apiKey: this.apiKey,
      iamToken: this.iamToken,
    });
  }

  protected buildConnectUrl(model: string): string {
    return buildYandexRealtimeUrl({
      folderId: this.folderId,
      model,
      baseURL: this.baseURL,
    });
  }
}

export function createYandexRealtimeFromConfig(
  config: Claw2Config,
  overrides?: Partial<YandexRealtimeOptions>
): YandexRealtimeProvider {
  const folderId = overrides?.folderId?.trim() || resolveSipRealtimeFolderId(config);
  if (!folderId) {
    throw new Error("Yandex Realtime: sip.realtime.folderId (or YANDEX_FOLDER_ID) is required");
  }
  const apiKey = overrides?.apiKey ?? resolveSipRealtimeApiKey(config);
  const iamToken = overrides?.iamToken ?? resolveSipRealtimeIamToken(config);
  if (!apiKey?.trim() && !iamToken?.trim()) {
    throw new Error("Yandex Realtime: apiKey or iamToken required (sip.realtime.*)");
  }
  return new YandexRealtimeProvider({
    folderId,
    apiKey: apiKey || undefined,
    iamToken: iamToken || undefined,
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
