/**
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * HSS core — see LICENSE-HSS.md
 */

import {
  evolveHssAndGetState,
  peekHssState,
  getHssEntropyDeltaStabilizeMin,
  type HssState,
} from "../claw-cache/hss-stabilizer.js";
import { setPendingHssResponseHint } from "../claw-cache/hss-pending-hint.js";
import {
  classifyResponseStrategy,
  type HssResponseStrategy,
} from "../claw-cache/hss-response-strategy.js";
import type OpenAI from "openai";
import type { Claw2Config } from "../config/types.js";

export type HssCoherenceStatus = "STABLE" | "FRAGMENTED" | "CRITICAL";

export interface HssAnalysisResult {
  status: HssCoherenceStatus;
  coherence: number;
  entropy: number;
  entropyDelta: number;
  recommendation?: string;
  state: HssState;
  responseStrategy: HssResponseStrategy;
  responseStrategyReason: string;
}

/**
 * HSS Middleware for semantic coherence analysis of LLM responses.
 * The node evolves according to the response text; status is tied to Δ entropy.
 */
export class HssMiddleware {
  static async analyzeResponse(
    sessionId: string,
    responseContent: string,
    config: Claw2Config,
    options?: { llmClient?: OpenAI }
  ): Promise<HssAnalysisResult | null> {
    const cacheId = config.orchestrator?.activationCache ?? "default";
    const trimmed = responseContent?.trim() ?? "";

    if (!trimmed) {
      const state = await peekHssState(sessionId, cacheId, config);
      if (!state) return null;
      return this.interpretState(state, config, sessionId, cacheId, "", { skippedEvolve: true });
    }

    const state = await evolveHssAndGetState(sessionId, cacheId, trimmed, config, {
      llmClient: options?.llmClient,
    });
    if (!state) return null;
    return this.interpretState(state, config, sessionId, cacheId, trimmed);
  }

  private static interpretState(
    state: HssState,
    config: Claw2Config,
    sessionId: string,
    cacheId: string,
    responseContent: string,
    opts?: { skippedEvolve?: boolean }
  ): HssAnalysisResult {
    const coherence = state.coherence ?? 1.0;
    const entropy = state.entropy ?? 0;
    const delta = state.effectiveDelta ?? state.maxChunkEntropyDelta ?? state.entropyDelta ?? 0;
    const deltaThreshold = getHssEntropyDeltaStabilizeMin(config);
    const criticalDelta = deltaThreshold * 3;
    let status: HssCoherenceStatus = "STABLE";
    let recommendation: string | undefined;

    if (coherence < 0.4 || delta >= criticalDelta) {
      status = "CRITICAL";
      recommendation =
        "WARNING: There is a sharp jump in semantic entropy in the previous answer. Ditch the reasoning and get back to the original facts.";
    } else if (delta >= deltaThreshold) {
      status = "FRAGMENTED";
      recommendation =
        "The previous answer recorded an increase in semantic entropy. Answer in a structured manner, without contradictions or hallucinations.";
    }

    if (opts?.skippedEvolve) {
      recommendation = recommendation
        ? `${recommendation}(answer analysis skipped: empty text)`
        : "Answer without text - the HSS state has not evolved from the model answer.";
    }

    const { responseStrategy, responseStrategyReason } = classifyResponseStrategy(responseContent);

    const result: HssAnalysisResult = {
      status,
      coherence,
      entropy,
      entropyDelta: delta,
      recommendation,
      state,
      responseStrategy,
      responseStrategyReason,
    };

    if (!opts?.skippedEvolve && responseStrategy !== "clarification") {
      setPendingHssResponseHint(sessionId, cacheId, {
        status: result.status,
        recommendation: result.recommendation,
        entropyDelta: result.entropyDelta,
        coherence: result.coherence,
      });
    }

    return result;
  }
}
