// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Public API Activation Engine (runtime): loading cache and building preamble.
 * The cache is injected only on the first request in the session.
 */

import { resolve } from "node:path";
import { loadCacheFromPath } from "./CacheLoader.js";
import { getCached, setCached } from "./CacheStore.js";
import { buildWarmupMessages } from "./WarmupBuilder.js";
import type { ClawCacheContent, ClawCacheActivationVector } from "./types.js";
import type { WarmupMessage, WarmupBuildResult } from "./WarmupBuilder.js";

export type { ClawCacheContent, ClawCacheActivationVector, WarmupMessage };
export {
  buildActivationVectorFromDialogueJsonl,
  buildActivationVectorFromMessages,
  activationVectorToNpyBuffer,
  activationVectorFromNpyBuffer,
  ACTIVATION_VECTOR_DIM,
} from "./activation-vector.js";
export type { ActivationVectorMatrix } from "./activation-vector.js";
export {
  setActivationVectorSeed,
  consumeActivationVectorSeed,
  releaseActivationVectorSeeds,
} from "./activation-vector-seed.js";
export { writeNpyFloat32, readNpyFloat32 } from "./npy.js";
export { buildWarmupMessages, parseDialogueJsonl, resolveDialogueWarmupTurnLimit } from "./WarmupBuilder.js";
export type { WarmupBuildResult, WarmupBuildOptions, WarmupSource } from "./WarmupBuilder.js";
export { scanTriggers, scanText, scanDialogueMessages, normalizeScanText, sanitizeDisplayText } from "./CacheInjectionScanner.js";
export type { ScanResult, ScanMatch, ScanCategory, DialogueScanResult, DialogueScanIssue } from "./CacheInjectionScanner.js";
export { applyWarmupContainment, escapeWarmupContent, WARMUP_OPEN, WARMUP_CLOSE } from "./warmup-containment.js";
export {
  loadOrCreateSigningKey,
  signCacheZip,
  verifyCacheSignature,
  verifyAndPinCacheKey,
  clearCacheKeyPin,
  CacheKeyConflictError,
} from "./cache-signature.js";
export type { CacheSigningKey, SignCacheResult, VerifyCacheResult } from "./cache-signature.js";
export { listCachesFromDir, listQuarantinedCaches } from "./list-catalog.js";
export type { CatalogCacheItem } from "./list-catalog.js";
export {
  importCacheIntoStore,
  acceptQuarantinedCache,
  renameCacheDisplayName,
  deleteCacheFile,
  safeCacheFileName,
} from "./catalog-manage.js";
export type { ImportCacheResult, AcceptCacheResult } from "./catalog-manage.js";
export { evolveHssAndGetState, peekHssState, resolveHssPromptMode, getHssEntropyStabilizeMin, getHssEntropyDeltaStabilizeMin, splitHssContextChunks, appendModelChronicleEntry, releaseHssSession } from "./hss-stabilizer.js";
export { recallChronicleForPrompt, searchChronicleSession, buildChronicleRecallPromptBlock } from "./chronicle-recall.js";
export { isChronicleChromaConfigured, isChronicleRecallEnabled, isChronicleStoreConfigured } from "./chronicle-chroma.js";
export { clampImportance } from "./chronicle-importance.js";
export { buildHssSystemPromptAddendum, resolveHssOrchestratorMode, HSS_CRITICAL_RETRY_USER_MESSAGE } from "./hss-orchestrator-prompt.js";
export type { HssOrchestratorMode } from "./hss-orchestrator-prompt.js";
export { stripInternalPromptLeak, sanitizeForChroniclePrompt } from "./prompt-leak-sanitize.js";
export { classifyResponseStrategy, shouldHssCriticalRetry, isHssRetryCatastrophicShrink, HSS_RESPONSE_CHAOS_MIN } from "./hss-response-strategy.js";
export type { HssResponseStrategy, ResponseStrategyResult, HssCoherenceStatus, HssCriticalRetryDecision } from "./hss-response-strategy.js";
export { computeChaosScore } from "./hss-chaos.js";
export {
  isHssFieldOntologyEnabled,
  formatFieldNodePromptLine,
  computeFieldNodeMetrics,
} from "./hss-field-ontology.js";
export type { FieldNodeMetrics, FieldSnapshot } from "./hss-field-ontology.js";
export { resolveTargetRhoDim, RHO_DIM_BASE, RHO_DIM_FULL } from "./hss-rho-dimension.js";
export { runLcpVerification, formatLcpReport } from "./hss-lcp.js";
export type { LcpResult, LcpOptions } from "./hss-lcp.js";
export { appendHssEpistemicHintIfNeeded, shouldAppendHssEpistemicHint, buildHssEpistemicHintFooter, stripHssEpistemicFooter, HSS_EPISTEMIC_MARKER } from "./hss-epistemic-hint.js";
export { packToClawCache } from "./CachePacker.js";
export type { ClawCachePackInput } from "./CachePacker.js";
export {
  exportSessionToClawCacheBuffer,
  buildSessionClawCachePackInput,
  messagesToDialogueJsonl,
  extractTriggersFromMessages,
  unwrapExtContent,
} from "./session-export.js";
export type { SessionClawCacheExportOptions, SessionDialogueMessage } from "./session-export.js";
export {
  consumePendingHssResponseHint,
  setPendingHssResponseHint,
  releasePendingHssHints,
} from "./hss-pending-hint.js";
export type { PendingHssResponseHint } from "./hss-pending-hint.js";
export type { HssState } from "./hss-stabilizer.js";

/**
 * Loads the cache by file path or by cache_id from the storage.
 * If pathOrId is the path to the .claw-cache file or cache_id (if storePath is specified).
 * If storePath is given and pathOrId does not resemble a path (no / or \), looks for the {storePath}/{pathOrId}.claw-cache file.
 */
export async function loadCache(pathOrId: string, storePath?: string | null): Promise<ClawCacheContent | null> {
  const fromStore = getCached(pathOrId);
  if (fromStore) return fromStore;

  const looksLikePath = /[/\\]/.test(pathOrId) || pathOrId.endsWith(".claw-cache");
  const resolved =
    storePath && !looksLikePath
      ? resolve(storePath, pathOrId.endsWith(".claw-cache") ? pathOrId : pathOrId + ".claw-cache")
      : resolve(pathOrId);
  try {
    const content = await loadCacheFromPath(resolved);
    setCached(content);
    return content;
  } catch {
    return null;
  }
}

/**
 * Same as loadCache but reports the load failure reason (integrity/signature/
 * size/parse) so callers can surface an actionable skip reason in audit/UI.
 */
export async function loadCacheDetailed(
  pathOrId: string,
  storePath?: string | null
): Promise<{ content: ClawCacheContent | null; error: string | null }> {
  const fromStore = getCached(pathOrId);
  if (fromStore) return { content: fromStore, error: null };

  const looksLikePath = /[/\\]/.test(pathOrId) || pathOrId.endsWith(".claw-cache");
  const resolved =
    storePath && !looksLikePath
      ? resolve(storePath, pathOrId.endsWith(".claw-cache") ? pathOrId : pathOrId + ".claw-cache")
      : resolve(pathOrId);
  try {
    const content = await loadCacheFromPath(resolved);
    setCached(content);
    return { content, error: null };
  } catch (err) {
    return { content: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Builds a preamble for insertion into the dialog (after system, before history).
 * Returns an empty array if the cache is not loaded or fails validation.
 */
export function getWarmupMessages(content: ClawCacheContent | null): WarmupMessage[] {
  if (!content) return [];
  return buildWarmupMessages(content).messages;
}

/** The full result of building a warmup (source, limits) is for audit.*/
export function getWarmupBuildResult(content: ClawCacheContent | null): WarmupBuildResult {
  if (!content) {
    return { messages: [], source: "none", turnLimit: 0, dialogueParsed: 0, filtered: [], failClosed: false };
  }
  return buildWarmupMessages(content);
}
