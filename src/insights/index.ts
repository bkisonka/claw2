// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

export type {
  InsightAskTemplateKey,
  InsightOffer,
  ClientInsightContext,
  InsightLinkerParams,
  InsightReasonCode,
  InsightSiblingDigest,
  InsightCandidate,
} from "./types.js";
export { buildInsightQuery, normalizeInsightTopic } from "./query.js";
export {
  lexicalOverlapScore,
  hasSoftTopicalOverlap,
  tokenize,
  classifySemanticReason,
} from "./score.js";
export { isClosingUserMessage, detectUnresolvedThread } from "./unresolved.js";
export { getInsightOffer, getInsightOfferWithBudget } from "./linker.js";
export { runCheapPass, formatInsightAddendum } from "./cheap-pass.js";
export { askTemplateKeyForReason, formatAskFallback } from "./templates.js";
export {
  insightStoreRecordDecision,
  insightStoreHas,
  insightCooldownActive,
} from "./store.js";
