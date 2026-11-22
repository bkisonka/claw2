// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Security policy separation for hosted (registration) mode.
 *
 * Per-user config in PostgreSQL is merged over the operator's file config to
 * build the effective configuration for that user's agent. A general-purpose
 * merge would let any registered user weaken isolation for their own session
 * (and the gateway executes with shared server authority): sandbox on/off,
 * host filesystem permissions, fs allowlist, channel credentials, audit
 * destinations — all are operator policy, not user preferences.
 *
 * Default-deny: a user config may only personalize the agent itself (model,
 * persona, voice, insight cards). Everything else is stripped — both when the
 * user saves settings and when the effective config is computed, so stale DB
 * rows written before this policy cannot smuggle admin keys back in.
 */

/** Top-level config keys a registered user may set for themselves. */
export const USER_CONFIG_ALLOWED_KEYS: readonly string[] = [
  // Bring-your-own model: provider, model, baseURL, user's own API key.
  "llm",
  // Persona / character of the assistant.
  "assistant",
  // Voice engine preferences (TTS engine, STT endpoint).
  "voice",
  // Dialogue insights cards (mode, thresholds) — feature toggles only.
  "insights",
];

/**
 * Strip every key outside USER_CONFIG_ALLOWED_KEYS. Non-object input returns
 * null (no user overrides apply).
 */
export function applyUserConfigPolicy(
  userConfig: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!userConfig || typeof userConfig !== "object" || Array.isArray(userConfig)) return null;
  const out: Record<string, unknown> = {};
  for (const key of USER_CONFIG_ALLOWED_KEYS) {
    if (key in userConfig) out[key] = userConfig[key];
  }
  return out;
}
