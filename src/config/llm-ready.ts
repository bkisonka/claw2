// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * LLM readiness helpers (onboarding + connections status).
 */
import type { Claw2Config } from "./types.js";

export function resolveLlmBaseURL(config: Claw2Config): string {
  return (config.llm?.baseURL?.trim() || process.env.OPENAI_BASE_URL?.trim() || "").replace(/\/+$/, "");
}

export function resolveLlmApiKey(config: Claw2Config): string {
  return config.llm?.apiKey?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
}

/** Local Ollama / LM Studio-style OpenAI-compatible endpoints that accept any non-empty key. */
export function isLikelyLocalLlmEndpoint(baseURL: string): boolean {
  if (!baseURL) return false;
  try {
    const u = new URL(baseURL.includes("://") ? baseURL : `http://${baseURL}`);
    const host = u.hostname;
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return false;
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    // Common local LLM ports
    return ["11434", "1234", "8080", "8000", "5000", "3000"].includes(port) || port === "443" || port === "80";
  } catch {
    return /127\.0\.0\.1|localhost/i.test(baseURL);
  }
}

export type LlmConfiguredResult = {
  ok: boolean;
  /** True when UI should show first-run setup */
  needsSetup: boolean;
  reason?: string;
  baseURL?: string;
  hasApiKey: boolean;
  localEndpoint: boolean;
};

/**
 * Credentials present enough to attempt LLM calls.
 * Remote APIs require an API key; local Ollama-style endpoints may omit key (SDK still needs a placeholder).
 */
export function assessLlmConfigured(config: Claw2Config): LlmConfiguredResult {
  const baseURL = resolveLlmBaseURL(config);
  const apiKey = resolveLlmApiKey(config);
  const localEndpoint = isLikelyLocalLlmEndpoint(baseURL);
  if (!baseURL) {
    return {
      ok: false,
      needsSetup: true,
      reason: "llm.baseURL not set",
      hasApiKey: !!apiKey,
      localEndpoint: false,
    };
  }
  if (!apiKey && !localEndpoint) {
    return {
      ok: false,
      needsSetup: true,
      reason: "llm.apiKey not set (required for remote providers)",
      baseURL,
      hasApiKey: false,
      localEndpoint: false,
    };
  }
  return {
    ok: true,
    needsSetup: false,
    baseURL,
    hasApiKey: !!apiKey,
    localEndpoint,
  };
}

/**
 * API key for OpenAI SDK. Never silently invent a key for remote hosts.
 * Local endpoints get placeholder `ollama` only when key is empty (SDK requires non-empty).
 */
export function resolveLlmApiKeyForClient(config: Claw2Config): { apiKey: string; placeholder: boolean } {
  const key = resolveLlmApiKey(config);
  if (key) return { apiKey: key, placeholder: false };
  const base = resolveLlmBaseURL(config);
  if (isLikelyLocalLlmEndpoint(base)) {
    return { apiKey: "ollama", placeholder: true };
  }
  return { apiKey: "", placeholder: false };
}
