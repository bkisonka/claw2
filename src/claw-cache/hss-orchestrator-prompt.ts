// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Uses the LGPL-licensed HSS core (hss.cjs, see LICENSE-HSS.md) via its API;
 * this file itself is licensed under AGPL-3.0-or-later (see LICENSE).
 */

import type { Claw2Config } from "../config/types.js";
import type { PendingHssResponseHint } from "./hss-pending-hint.js";
import {
  getHssEntropyDeltaStabilizeMin,
  resolveHssPromptMode,
  type HssState,
} from "./hss-stabilizer.js";
import { formatFieldNodePromptLine, isHssFieldOntologyEnabled } from "./hss-field-ontology.js";

export type HssOrchestratorMode = "stable" | "stabilize" | "critical";

export function resolveHssOrchestratorMode(
  hssState: HssState | null,
  pending: PendingHssResponseHint | null,
  config: Claw2Config
): HssOrchestratorMode {
  if (pending?.status === "CRITICAL") return "critical";
  if (pending?.status === "FRAGMENTED") return "stabilize";
  if (!hssState) return "stable";
  return resolveHssPromptMode(hssState, config) === "stabilize" ? "stabilize" : "stable";
}

export function buildHssSystemPromptAddendum(
  hssState: HssState | null,
  pending: PendingHssResponseHint | null,
  config: Claw2Config
): { mode: HssOrchestratorMode; text: string } {
  const mode = resolveHssOrchestratorMode(hssState, pending, config);
  const threshold = getHssEntropyDeltaStabilizeMin(config);
  const delta = hssState?.effectiveDelta ?? hssState?.maxChunkEntropyDelta ?? hssState?.entropyDelta ?? 0;
  const chaos = hssState?.chaosScore ?? 0;

  if (mode === "critical") {
    const pendingLine = pending?.recommendation ? `${pending.recommendation}\n\n` : "";
    return {
      mode,
      text: `${pendingLine}[HSS · CRITICAL] Semantic instability. Answer strictly according to the facts from the dialogue and <<<EXT>>>. One position, no contradictions. If there is not enough data, say directly what is missing. Don't repeat the same follow-up question.`,
    };
  }

  if (mode === "stabilize") {
    const pendingLine = pending?.recommendation ? `${pending.recommendation}\n\n` : "";
    const chunkNote =
      hssState?.chunkCount && hssState.chunkCount > 1 ? ` Input is split into ${hssState.chunkCount} chunks.` : "";
    return {
      mode,
      text: `${pendingLine}[HSS · STABILIZE] Growth of semantic entropy (ΔS≈${delta.toFixed(4)} ≥ ${threshold}${chaos > 0 ? `, input chaos ${chaos.toFixed(2)}` : ""}).${chunkNote} Structured answer, one line of reasoning, no contradictions.`,
    };
  }

  if (hssState?.calibrationTurn) {
    return {
      mode: "stable",
      text: "[HSS · CALIBRATION] First session state measurement - respond naturally.",
    };
  }

  const nodeLine =
    config &&
    isHssFieldOntologyEnabled(config) &&
    hssState?.field
      ? `${formatFieldNodePromptLine(hssState.field, hssState.rhoDim)}\n\n`
      : "";

  return {
    mode: "stable",
    text: `${nodeLine}[HSS STABLE] Semantic entropy is stable (ΔS <${threshold}). You conduct a dialogue in a stable mode.`,
  };
}

export const HSS_CRITICAL_RETRY_USER_MESSAGE =
  "[HSS] The previous answer is considered unstable. Give a new answer: only facts from the dialogue, one position, without repeated clarifying questions.";
