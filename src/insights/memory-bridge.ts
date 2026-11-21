// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import OpenAI from "openai";
import type { Claw2Config } from "../config/types.js";
import { memoryRecallScored } from "../memory/index.js";
import type { InsightCandidate, InsightSiblingDigest } from "./types.js";
import { classifySemanticReason, lexicalOverlapScore } from "./score.js";
import { normalizeInsightTopic } from "./query.js";

export async function searchDigestCandidates(
  query: string,
  siblings: InsightSiblingDigest[],
  minScore: number
): Promise<InsightCandidate[]> {
  if (!query.trim() || siblings.length === 0) return [];
  const out: InsightCandidate[] = [];
  for (const s of siblings) {
    const blob = `${s.title}\n${s.digest}`;
    const raw = lexicalOverlapScore(query, blob);
    // Lexical Jaccard is typically << cosine; scale so minScore~0.72 remains usable.
    const score = Math.min(1, raw * 2.8);
    if (score < minScore) continue;
    const reasonCode = classifySemanticReason(query, blob);
    out.push({
      reasonCode,
      pastChatId: s.id,
      pastChatTitle: (s.title || "Chat").trim() || "Chat",
      pastChatUpdatedAt: s.updatedAt ?? Date.now(),
      score,
      insightTopic: normalizeInsightTopic(s.title) || "related",
      excerpts: [s.digest.replace(/\s+/g, " ").trim().slice(0, 280)].filter(Boolean),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

export async function searchMemoryCandidates(
  client: OpenAI,
  config: Claw2Config,
  query: string,
  minScore: number,
  userId: string
): Promise<InsightCandidate[]> {
  if (!query.trim() || !config.memory?.enabled) return [];
  const { chunks } = await memoryRecallScored(client, config, query, 5, { userId });
  const out: InsightCandidate[] = [];
  for (const c of chunks) {
    if (c.score < minScore) continue;
    // Memory chunks are not chat-bound; skip unless text mentions a chat-like title — v1: use as weak pattern only with synthetic id skip
    // Linker only offers past chats; memory without pastChatId cannot open a chat.
    // Keep memory as boost: if chunk text looks like a digests echo, still need pastChatId.
    // For v1 we only use memory when we can pair with a digest candidate later — return tagged orphans with empty pastChatId filtered out.
    void c;
  }
  // Memory alone cannot produce openable offers (no pastChatId). Return empty; digests + unresolved carry chat ids.
  // Still expose high-scoring memory excerpts for digest boost in linker.
  for (const c of chunks) {
    if (c.score < minScore) continue;
    out.push({
      reasonCode: classifySemanticReason(query, c.text),
      pastChatId: "", // filtered by linker unless matched to sibling
      pastChatTitle: "",
      pastChatUpdatedAt: 0,
      score: c.score,
      insightTopic: normalizeInsightTopic(c.text.slice(0, 60)) || "memory",
      excerpts: [c.text.replace(/\s+/g, " ").trim().slice(0, 280)],
    });
  }
  return out;
}

/** Boost digest candidates whose excerpts overlap memory hits. */
export function boostDigestsWithMemory(
  digests: InsightCandidate[],
  memoryHits: InsightCandidate[]
): InsightCandidate[] {
  if (!memoryHits.length) return digests;
  return digests.map((d) => {
    let boost = 0;
    for (const m of memoryHits) {
      const overlap = lexicalOverlapScore(d.excerpts.join(" "), m.excerpts.join(" "));
      if (overlap > 0.12) boost = Math.max(boost, m.score * 0.15 * overlap);
    }
    return { ...d, score: Math.min(1, d.score + boost) };
  });
}
