// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import type { Claw2Config } from "../config/types.js";
import { isLikelyLocalLlmEndpoint, resolveLlmBaseURL } from "../config/llm-ready.js";

export type PrivacyApplyDecision = {
  apply: boolean;
  reason: "disabled" | "local_skipped" | "apply_remote" | "apply_local";
  localEndpoint: boolean;
  baseURL: string;
};

/** Whether outbound LLM traffic should be PII-masked. */
export function shouldApplyPrivacy(config: Claw2Config): PrivacyApplyDecision {
  const baseURL = resolveLlmBaseURL(config);
  const localEndpoint = isLikelyLocalLlmEndpoint(baseURL);
  const enabled = config.privacy?.enabled === true;
  if (!enabled) {
    return { apply: false, reason: "disabled", localEndpoint, baseURL };
  }
  if (localEndpoint && config.privacy?.applyToLocal !== true) {
    return { apply: false, reason: "local_skipped", localEndpoint, baseURL };
  }
  return {
    apply: true,
    reason: localEndpoint ? "apply_local" : "apply_remote",
    localEndpoint,
    baseURL,
  };
}

/** Coding-model baseURL may differ from llm.baseURL. */
export function shouldApplyPrivacyForBaseURL(
  config: Claw2Config,
  baseURLRaw: string | undefined
): PrivacyApplyDecision {
  const baseURL = (baseURLRaw || resolveLlmBaseURL(config)).replace(/\/+$/, "");
  const localEndpoint = isLikelyLocalLlmEndpoint(baseURL);
  const enabled = config.privacy?.enabled === true;
  if (!enabled) {
    return { apply: false, reason: "disabled", localEndpoint, baseURL };
  }
  if (localEndpoint && config.privacy?.applyToLocal !== true) {
    return { apply: false, reason: "local_skipped", localEndpoint, baseURL };
  }
  return {
    apply: true,
    reason: localEndpoint ? "apply_local" : "apply_remote",
    localEndpoint,
    baseURL,
  };
}
