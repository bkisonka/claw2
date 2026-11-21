// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import OpenAI from "openai";
import type { Claw2Config } from "../config/types.js";
import type { ChatRepository } from "../gateway/db/chat-repository.js";
import { createClient } from "../core/llm.js";
import { buildInsightQuery } from "./query.js";
import {
  boostDigestsWithMemory,
  searchDigestCandidates,
  searchMemoryCandidates,
} from "./memory-bridge.js";
import { detectUnresolvedThread } from "./unresolved.js";
import { askTemplateKeyForReason } from "./templates.js";
import { insightCooldownActive, insightStoreHas, insightStoreRecordOffered } from "./store.js";
import type {
  InsightCandidate,
  InsightLinkerParams,
  InsightOffer,
  InsightSiblingDigest,
} from "./types.js";

export interface GetInsightOfferDeps {
  config: Claw2Config;
  chatRepo: ChatRepository | null;
  siblings?: InsightSiblingDigest[];
  /** Optional pre-built OpenAI client (tests / reuse). */
  client?: OpenAI;
}

function makeOfferId(): string {
  return `off_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function candidateToOffer(c: InsightCandidate, offerId: string): InsightOffer {
  return {
    offerId,
    reasonCode: c.reasonCode,
    pastChatId: c.pastChatId,
    pastChatTitle: c.pastChatTitle,
    pastChatUpdatedAt: c.pastChatUpdatedAt,
    score: c.score,
    insightTopic: c.insightTopic,
    excerpts: c.excerpts.slice(0, 3),
    askTemplateKey: askTemplateKeyForReason(c.reasonCode),
  };
}

function pickBest(params: {
  bestSemantic: InsightCandidate | null;
  unresolved: InsightCandidate | null;
  minScore: number;
}): InsightCandidate | null {
  const { bestSemantic, unresolved, minScore } = params;
  const semOk = bestSemantic && bestSemantic.score >= minScore ? bestSemantic : null;
  if (unresolved && semOk) {
    // Strong unresolved can beat semantic
    if (unresolved.score >= semOk.score - 0.05) return unresolved;
    return semOk;
  }
  return unresolved ?? semOk;
}

export async function getInsightOffer(
  params: InsightLinkerParams,
  deps: GetInsightOfferDeps
): Promise<InsightOffer | null> {
  const cfg = deps.config.insights;
  if (!cfg || cfg.enabled === false) return null;
  const mode = cfg.mode ?? "ask";
  if (mode === "off") return null;

  const repo = deps.chatRepo;
  if (!repo) return null;

  const nowMs = params.nowMs ?? Date.now();
  const cooldownSec = cfg.cooldownSec ?? 300;
  if (insightCooldownActive(repo, params.sessionId, params.userId, cooldownSec, nowMs)) {
    return null;
  }

  const minScore = cfg.minScore ?? 0.72;
  const query = buildInsightQuery({
    userText: params.userText,
    pageTitle: params.pageTitle,
    pageKey: params.pageKey,
  });

  let bestSemantic: InsightCandidate | null = null;
  if ((cfg.useProjectDigests !== false) && deps.siblings?.length) {
    let digests = await searchDigestCandidates(query, deps.siblings, minScore);
    if (cfg.useMemory !== false && deps.config.memory?.enabled && query) {
      try {
        const client = deps.client ?? createClient(deps.config);
        const mem = await searchMemoryCandidates(client, deps.config, query, 0.45, params.userId);
        digests = boostDigestsWithMemory(digests, mem);
      } catch {
        /* memory optional */
      }
    }
    digests = digests.filter((d) => d.pastChatId && d.score >= minScore);
    digests.sort((a, b) => b.score - a.score);
    bestSemantic = digests[0] ?? null;
  }

  let unresolved: InsightCandidate | null = null;
  if (cfg.useUnresolvedThreads !== false) {
    const ageSec = cfg.unresolvedMinAgeSec ?? 86400;
    const chats = repo.listRecentChatsForInsights(params.userId, params.sessionId, 16);
    for (const chat of chats) {
      if (insightStoreHas(repo, params.userId, chat.id, "unresolved_thread", normalizeTopic(chat.title))) {
        continue;
      }
      const tail = repo.getChatMessageTail(chat.id, params.userId, 12);
      const cand = detectUnresolvedThread({
        chatId: chat.id,
        title: chat.title,
        updatedAt: chat.updated_at,
        tail,
        nowMs,
        unresolvedMinAgeSec: ageSec,
        query,
        idleScan: params.idleScan,
      });
      if (!cand) continue;
      if (insightStoreHas(repo, params.userId, cand.pastChatId, cand.reasonCode, cand.insightTopic)) {
        continue;
      }
      if (!unresolved || cand.score > unresolved.score) unresolved = cand;
    }
  }

  if (bestSemantic) {
    if (
      insightStoreHas(
        repo,
        params.userId,
        bestSemantic.pastChatId,
        bestSemantic.reasonCode,
        bestSemantic.insightTopic
      )
    ) {
      bestSemantic = null;
    }
  }

  const chosen = pickBest({ bestSemantic, unresolved, minScore });
  if (!chosen || !chosen.pastChatId) return null;

  const offerId = makeOfferId();
  try {
    insightStoreRecordOffered(repo, {
      userId: params.userId,
      chatId: params.sessionId,
      pastChatId: chosen.pastChatId,
      reasonCode: chosen.reasonCode,
      insightTopic: chosen.insightTopic,
      score: chosen.score,
      offerId,
    });
  } catch {
    /* persist offered is best-effort */
  }

  return candidateToOffer(chosen, offerId);
}

function normalizeTopic(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/** Race linker against budget; returns null on timeout/error. */
export async function getInsightOfferWithBudget(
  params: InsightLinkerParams,
  deps: GetInsightOfferDeps
): Promise<InsightOffer | null> {
  const budgetMs = deps.config.insights?.budgetMs ?? 350;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      getInsightOffer(params, deps),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budgetMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
