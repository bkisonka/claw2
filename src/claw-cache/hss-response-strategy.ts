/**
 * Model response strategy in the HSS stabilize context:
 * clarification — in-bounds clarification (normal for contradictory input),
 * answer — substantive answer,
 * violation — internal contradictions in the reply (out of bounds).
 */

import { computeChaosScore } from "./hss-chaos.js";

export type HssResponseStrategy = "clarification" | "answer" | "violation";

/** Min. chaosScore on the response text for violation and critical retry.*/
export const HSS_RESPONSE_CHAOS_MIN = 0.2;

export type HssCoherenceStatus = "STABLE" | "FRAGMENTED" | "CRITICAL";

export interface HssCriticalRetryDecision {
  retry: boolean;
  chaosScore: number;
  retryReason?: string;
  skipReason?: string;
}

const CLARIFICATION_PATTERNS: RegExp[] = [
  /какую\s+(справку|информацию|погоду|версию)/i,
  /какой\s+(именно|вариант|адрес|город)/i,
  /что\s+вы\s+имеете\s+в\s+виду/i,
  /уточн/i,
  /не\s+могли\s+бы\s+вы/i,
  /could\s+you\s+clarify/i,
  /which\s+(one|option)/i,
  /вы\s+имеете\s+в\s+виду/i,
  /поясните/i,
  /уточните/i,
];

const SERVICE_PROMPT_PATTERNS: RegExp[] = [
  /чем\s+(я\s+)?могу\s+(вам\s+)?помочь/i,
  /как\s+я\s+могу\s+вам\s+помочь/i,
  /how\s+can\s+i\s+help/i,
];

export interface ResponseStrategyResult {
  responseStrategy: HssResponseStrategy;
  responseStrategyReason: string;
}

export function classifyResponseStrategy(text: string): ResponseStrategyResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { responseStrategy: "answer", responseStrategyReason: "empty" };
  }

  const chaos = computeChaosScore(trimmed);
  if (chaos >= HSS_RESPONSE_CHAOS_MIN) {
    return {
      responseStrategy: "violation",
      responseStrategyReason: `internal_contradiction_chaos_${chaos.toFixed(2)}`,
    };
  }

  const endsWithQuestion = /\?\s*$/.test(trimmed);
  const clarificationPattern = CLARIFICATION_PATTERNS.find((p) => p.test(trimmed));
  const servicePrompt = SERVICE_PROMPT_PATTERNS.find((p) => p.test(trimmed));

  if (clarificationPattern) {
    return {
      responseStrategy: "clarification",
      responseStrategyReason: `pattern:${clarificationPattern.source.slice(0, 40)}`,
    };
  }

  if (servicePrompt && trimmed.length < 100) {
    return {
      responseStrategy: "clarification",
      responseStrategyReason: "service_prompt",
    };
  }

  if (endsWithQuestion && trimmed.length < 160) {
    return { responseStrategy: "clarification", responseStrategyReason: "short_question" };
  }

  if (endsWithQuestion && (trimmed.match(/\?/g) || []).length >= 1 && trimmed.length < 280) {
    const statementRatio = trimmed.replace(/[^.!?]/g, "").length;
    if (statementRatio <= 2) {
      return { responseStrategy: "clarification", responseStrategyReason: "mostly_question" };
    }
  }

  return { responseStrategy: "answer", responseStrategyReason: "substantive" };
}

/**
 * Retry with CRITICAL only if the answer really “breaks the framework” (violation / high chaos),
 * rather than just long, connected text with high ΔS.
 */
export function shouldHssCriticalRetry(
  analysisStatus: HssCoherenceStatus,
  responseStrategy: HssResponseStrategy,
  responseContent: string
): HssCriticalRetryDecision {
  const chaosScore = computeChaosScore(responseContent);
  if (analysisStatus !== "CRITICAL") {
    return { retry: false, chaosScore, skipReason: "not_critical" };
  }
  if (responseStrategy === "violation" || chaosScore >= HSS_RESPONSE_CHAOS_MIN) {
    return {
      retry: true,
      chaosScore,
      retryReason:
        responseStrategy === "violation" ? "violation" : `chaos_${chaosScore.toFixed(2)}`,
    };
  }
  return {
    retry: false,
    chaosScore,
    skipReason: `critical_delta_only strategy=${responseStrategy}`,
  };
}

/**
 * Retry, which collapses the already streamed long answer into a short introductory one -
 * do not accept (otherwise the UI “text appeared and disappeared”).
 */
export function isHssRetryCatastrophicShrink(beforeLen: number, afterLen: number): boolean {
  if (beforeLen < 200) return afterLen > 0 && afterLen < 40 && beforeLen >= 80;
  if (beforeLen < 800) return afterLen < beforeLen * 0.35;
  return afterLen < beforeLen * 0.4 || afterLen < 280;
}
