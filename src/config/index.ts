// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

export type { Claw2Config, SipMediaBackendMode, SipRealtimeConfig, SipRealtimeProvider } from "./types.js";
export { DEFAULT_CONFIG } from "./types.js";
export { loadConfig, getConfigPath } from "./load.js";
export {
  isPhoneCallToolEnabled,
  isSipConfigured,
  isSipRealtimeEnabled,
  resolveSipAutoAnswer,
  resolveSipDisplayName,
  resolveSipDomain,
  resolveSipLocalPort,
  resolveSipOperatorUri,
  resolveSipPassword,
  resolveSipPort,
  resolveSipPublicAddress,
  resolveSipRealtimeApiKey,
  resolveSipRealtimeBaseURL,
  resolveSipRealtimeFolderId,
  resolveSipRealtimeIamToken,
  resolveSipRealtimeModel,
  resolveSipRealtimeProvider,
  resolveSipRealtimeSampleRate,
  resolveSipRealtimeVoice,
  resolveSipRegisterExpires,
  resolveSipServer,
  resolveSipUser,
} from "./sip.js";
