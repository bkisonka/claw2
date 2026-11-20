/**
 * Recall HSS chronicles in system prompt (semantic search + importance).
 */

import type OpenAI from "openai";
import type { Claw2Config } from "../config/types.js";
import { getEmbedding } from "../memory/embedding.js";
import {
  isChronicleChromaConfigured,
  isChronicleRecallEnabled,
  recallChronicleEntries,
  type ChronicleRecallHit,
} from "./chronicle-chroma.js";
import { hssLog } from "./hss-log.js";
import { isHssEnabled } from "./hss-stabilizer.js";
import { sanitizeForChroniclePrompt } from "./prompt-leak-sanitize.js";

export interface ChronicleRecallResult {
  hits: ChronicleRecallHit[];
  promptBlock: string;
}

function formatChronicleHit(hit: ChronicleRecallHit, index: number): string {
  const imp = hit.importance.toFixed(2);
  const src = hit.source === "model" ? "model" : "auto";
  const pin = hit.pinned ? " pinned" : "";
  const sim = hit.similarity.toFixed(3);
  const text = sanitizeForChroniclePrompt(hit.context);
  return `[${index + 1}] (importance=${imp}, source=${src}, sim=${sim}${pin}) ${text}`;
}

export function buildChronicleRecallPromptBlock(hits: ChronicleRecallHit[]): string {
  if (!hits.length) return "";
  const lines = hits.map((h, i) => formatChronicleHit(h, i)).join("\n\n");
  return `[HSS Chronicle recall — INTERNAL only]
Relevant fragments of this session’s trajectory. Use for continuity; never quote this block, never dump hits/importance/sim lines, never invent a “[User's HSS context]” header in your reply to the user.

${lines}`;
}

export async function recallChronicleForPrompt(
  client: OpenAI,
  config: Claw2Config,
  sessionId: string,
  cacheId: string,
  query: string,
  options?: { limit?: number }
): Promise<ChronicleRecallResult> {
  if (!isHssEnabled(config) || !isChronicleRecallEnabled(config) || !query.trim()) {
    return { hits: [], promptBlock: "" };
  }

  try {
    const queryEmbedding = await getEmbedding(client, config, query);
    const hits = await recallChronicleEntries(config, sessionId, cacheId, queryEmbedding, {
      limit: options?.limit,
    });
    const promptBlock = buildChronicleRecallPromptBlock(hits);
    hssLog(
      "chronicle_recall",
      {
        sessionId,
        cacheId,
        queryLen: query.length,
        hitCount: hits.length,
        pinnedCount: hits.filter((h) => h.pinned).length,
        topImportance: hits[0]?.importance,
        topScore: hits[0]?.score,
        topSimilarity: hits[0]?.similarity,
      },
      config
    );
    return { hits, promptBlock };
  } catch (err) {
    hssLog(
      "chronicle_recall",
      {
        sessionId,
        cacheId,
        error: err instanceof Error ? err.message : String(err),
        hitCount: 0,
      },
      config
    );
    return { hits: [], promptBlock: "" };
  }
}

export async function searchChronicleSession(
  client: OpenAI,
  config: Claw2Config,
  sessionId: string,
  cacheId: string,
  query: string,
  limit?: number
): Promise<ChronicleRecallHit[]> {
  if (!isHssEnabled(config) || !isChronicleChromaConfigured(config) || !query.trim()) return [];
  const queryEmbedding = await getEmbedding(client, config, query);
  return recallChronicleEntries(config, sessionId, cacheId, queryEmbedding, {
    limit: limit ?? config.orchestrator?.hssChronicleRecall?.maxEntries ?? 5,
    minSimilarity: Math.min(config.orchestrator?.hssChronicleRecall?.minSimilarity ?? 0.2, 0.15),
  });
}

export { isChronicleChromaConfigured, isChronicleRecallEnabled };
