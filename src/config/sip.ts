// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * SIP settings resolvers (virtual PBX).
 */
import type { Claw2Config, SipRealtimeProvider } from "./types.js";

export function isSipConfigured(config: Claw2Config): boolean {
  return isPhoneCallToolEnabled(config);
}

/** Tool phone_call: sip.enabled is explicitly enabled and details are specified.*/
export function isPhoneCallToolEnabled(config: Claw2Config): boolean {
  if (config.sip?.enabled !== true) return false;
  return !!(resolveSipServer(config) && resolveSipUser(config) && resolveSipPassword(config));
}

export function resolveSipServer(config: Claw2Config): string {
  return (
    process.env.CLAW2_SIP_SERVER?.trim() ||
    config.sip?.server?.trim() ||
    ""
  );
}

export function resolveSipDomain(config: Claw2Config): string {
  return (
    process.env.CLAW2_SIP_DOMAIN?.trim() ||
    config.sip?.domain?.trim() ||
    resolveSipServer(config)
  );
}

export function resolveSipUser(config: Claw2Config): string {
  return process.env.CLAW2_SIP_USER?.trim() || config.sip?.user?.trim() || "";
}

export function resolveSipPassword(config: Claw2Config): string {
  return process.env.CLAW2_SIP_PASSWORD?.trim() || config.sip?.password?.trim() || "";
}

export function resolveSipPort(config: Claw2Config): number {
  const env = process.env.CLAW2_SIP_PORT?.trim();
  if (env && /^\d+$/.test(env)) return Math.max(1, Math.min(65535, Number(env)));
  const p = config.sip?.port;
  return typeof p === "number" && p > 0 ? Math.min(65535, p) : 5060;
}

export function resolveSipLocalPort(config: Claw2Config): number {
  const env = process.env.CLAW2_SIP_LOCAL_PORT?.trim();
  if (env && /^\d+$/.test(env)) return Math.max(1, Math.min(65535, Number(env)));
  const p = config.sip?.localPort;
  return typeof p === "number" && p > 0 ? Math.min(65535, p) : 5061;
}

export function resolveSipPublicAddress(config: Claw2Config): string | undefined {
  const v = process.env.CLAW2_SIP_PUBLIC_ADDRESS?.trim() || config.sip?.publicAddress?.trim();
  return v || undefined;
}

export function resolveSipDisplayName(config: Claw2Config): string {
  return (
    process.env.CLAW2_SIP_DISPLAY_NAME?.trim() ||
    config.sip?.displayName?.trim() ||
    resolveSipUser(config) ||
    "claw2"
  );
}

export function resolveSipRegisterExpires(config: Claw2Config): number {
  const env = process.env.CLAW2_SIP_REGISTER_EXPIRES?.trim();
  if (env && /^\d+$/.test(env)) return Math.max(60, Number(env));
  const n = config.sip?.registerExpires;
  return typeof n === "number" && n >= 60 ? n : 300;
}

export function resolveSipAutoAnswer(config: Claw2Config): boolean {
  const env = process.env.CLAW2_SIP_AUTO_ANSWER?.trim().toLowerCase();
  if (env === "1" || env === "true" || env === "yes") return true;
  if (env === "0" || env === "false" || env === "no") return false;
  return config.sip?.autoAnswer === true;
}

export function resolveSipOperatorUri(config: Claw2Config): string {
  return process.env.CLAW2_SIP_OPERATOR_URI?.trim() || config.sip?.operatorUri?.trim() || "";
}

/** Realtime provider; missing / unknown → off (batch pipeline). */
export function resolveSipRealtimeProvider(config: Claw2Config): SipRealtimeProvider {
  const env = process.env.CLAW2_SIP_REALTIME_PROVIDER?.trim().toLowerCase();
  if (
    env === "off" ||
    env === "pipeline" ||
    env === "yandex" ||
    env === "openai" ||
    env === "xai"
  ) {
    return env;
  }
  const p = config.sip?.realtime?.provider;
  if (p === "pipeline" || p === "yandex" || p === "openai" || p === "xai" || p === "off") {
    return p;
  }
  return "off";
}

/** True when speech-to-speech Realtime should run (not off/pipeline). */
export function isSipRealtimeEnabled(config: Claw2Config): boolean {
  const p = resolveSipRealtimeProvider(config);
  return p === "yandex" || p === "openai" || p === "xai";
}

/**
 * API key for Realtime. Does not fall back to llm.apiKey unless useLlmApiKey is true.
 * Yandex: also accepts YANDEX_API_KEY when provider is yandex.
 */
export function resolveSipRealtimeApiKey(config: Claw2Config): string {
  const rt = config.sip?.realtime;
  const own =
    process.env.CLAW2_SIP_REALTIME_API_KEY?.trim() ||
    rt?.apiKey?.trim() ||
    "";
  if (own) return own;

  const provider = resolveSipRealtimeProvider(config);
  if (provider === "yandex") {
    const yandex = process.env.YANDEX_API_KEY?.trim();
    if (yandex) return yandex;
  }

  const useLlmEnv = process.env.CLAW2_SIP_REALTIME_USE_LLM_API_KEY?.trim().toLowerCase();
  const useLlm =
    useLlmEnv === "1" ||
    useLlmEnv === "true" ||
    useLlmEnv === "yes" ||
    rt?.useLlmApiKey === true;
  if (useLlm) {
    return (
      config.llm?.apiKey?.trim() ||
      process.env.OPENAI_API_KEY?.trim() ||
      ""
    );
  }
  return "";
}

export function resolveSipRealtimeFolderId(config: Claw2Config): string {
  return (
    process.env.CLAW2_SIP_REALTIME_FOLDER_ID?.trim() ||
    process.env.YANDEX_FOLDER_ID?.trim() ||
    config.sip?.realtime?.folderId?.trim() ||
    ""
  );
}

export function resolveSipRealtimeIamToken(config: Claw2Config): string {
  return (
    process.env.CLAW2_SIP_REALTIME_IAM_TOKEN?.trim() ||
    process.env.YANDEX_IAM_TOKEN?.trim() ||
    config.sip?.realtime?.iamToken?.trim() ||
    ""
  );
}

export function resolveSipRealtimeModel(config: Claw2Config): string {
  return (
    process.env.CLAW2_SIP_REALTIME_MODEL?.trim() ||
    config.sip?.realtime?.model?.trim() ||
    ""
  );
}

export function resolveSipRealtimeVoice(config: Claw2Config): string {
  return (
    process.env.CLAW2_SIP_REALTIME_VOICE?.trim() ||
    config.sip?.realtime?.voice?.trim() ||
    ""
  );
}

export function resolveSipRealtimeSampleRate(config: Claw2Config): number | undefined {
  const env = process.env.CLAW2_SIP_REALTIME_SAMPLE_RATE?.trim();
  if (env && /^\d+$/.test(env)) {
    const n = Number(env);
    return n > 0 ? n : undefined;
  }
  const n = config.sip?.realtime?.sampleRate;
  return typeof n === "number" && n > 0 ? n : undefined;
}

export function resolveSipRealtimeBaseURL(config: Claw2Config): string {
  return (
    process.env.CLAW2_SIP_REALTIME_BASE_URL?.trim() ||
    config.sip?.realtime?.baseURL?.trim() ||
    ""
  );
}
