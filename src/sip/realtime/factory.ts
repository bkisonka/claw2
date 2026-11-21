// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Create a Realtime provider from sip.realtime config, or null when off/pipeline.
 */
import type { Claw2Config } from "../../config/types.js";
import {
  isSipRealtimeEnabled,
  resolveSipRealtimeProvider,
} from "../../config/sip.js";
import type { RealtimeProvider } from "./provider.js";
import { createOpenAiRealtimeFromConfig } from "./openai.js";
import { createXaiRealtimeFromConfig } from "./xai.js";
import { createYandexRealtimeFromConfig } from "./yandex.js";

export function createRealtimeProviderFromConfig(
  config: Claw2Config,
  opts?: { callId?: string }
): RealtimeProvider | null {
  if (!isSipRealtimeEnabled(config)) return null;
  const provider = resolveSipRealtimeProvider(config);
  const callId = opts?.callId;
  switch (provider) {
    case "yandex":
      return createYandexRealtimeFromConfig(config, { callId });
    case "openai":
      return createOpenAiRealtimeFromConfig(config, { callId });
    case "xai":
      return createXaiRealtimeFromConfig(config, { callId });
    default:
      return null;
  }
}
