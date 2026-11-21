// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it } from "vitest";
import { isClosingUserMessage, detectUnresolvedThread } from "./unresolved.js";
import { lexicalOverlapScore, hasSoftTopicalOverlap } from "./score.js";
import { buildInsightQuery, normalizeInsightTopic } from "./query.js";

describe("isClosingUserMessage", () => {
  it("accepts thanks / сработало", () => {
    expect(isClosingUserMessage("спасибо")).toBe(true);
    expect(isClosingUserMessage("помогло")).toBe(true);
    expect(isClosingUserMessage("thanks!")).toBe(true);
    expect(isClosingUserMessage("done")).toBe(true);
  });

  it("treats bare ok as closing only as whole short message", () => {
    expect(isClosingUserMessage("ok")).toBe(true);
    expect(isClosingUserMessage("ок")).toBe(true);
    expect(isClosingUserMessage("ok, а как тогда парсить xml?")).toBe(false);
  });

  it("rejects open questions", () => {
    expect(isClosingUserMessage("а как обойти лимит?")).toBe(false);
  });
});

describe("detectUnresolvedThread", () => {
  const day = 86_400_000;
  const now = Date.UTC(2026, 6, 31, 12, 0, 0);

  it("offers when question→answer→aged silence and topical overlap", () => {
    const cand = detectUnresolvedThread({
      chatId: "past1",
      title: "Парсинг Hermes",
      updatedAt: now - 2 * day,
      nowMs: now,
      unresolvedMinAgeSec: 86400,
      query: "как парсить hermes лимит",
      idleScan: false,
      tail: [
        { role: "user", content: "Как обойти лимит парсинга Hermes?", created_at: now - 2 * day },
        {
          role: "assistant",
          content: "Можно батчить запросы и кэшировать ответы.",
          created_at: now - 2 * day + 1000,
        },
      ],
    });
    expect(cand?.reasonCode).toBe("unresolved_thread");
    expect(cand?.pastChatId).toBe("past1");
  });

  it("no offer after closing thanks", () => {
    const cand = detectUnresolvedThread({
      chatId: "past1",
      title: "Парсинг Hermes",
      updatedAt: now - 2 * day,
      nowMs: now,
      unresolvedMinAgeSec: 86400,
      query: "парсинг hermes",
      idleScan: false,
      tail: [
        { role: "user", content: "Как обойти лимит?", created_at: now - 2 * day },
        { role: "assistant", content: "Батчинг.", created_at: now - 2 * day + 1000 },
        { role: "user", content: "спасибо, помогло", created_at: now - 2 * day + 2000 },
      ],
    });
    // User returned after assistant — not abandoned
    expect(cand).toBeNull();
  });

  it("no offer when age below threshold", () => {
    const cand = detectUnresolvedThread({
      chatId: "past1",
      title: "Парсинг Hermes",
      updatedAt: now - 5 * 60_000,
      nowMs: now,
      unresolvedMinAgeSec: 86400,
      query: "парсинг hermes",
      idleScan: false,
      tail: [
        { role: "user", content: "Как обойти лимит парсинга?", created_at: now - 5 * 60_000 },
        { role: "assistant", content: "Батчинг.", created_at: now - 4 * 60_000 },
      ],
    });
    expect(cand).toBeNull();
  });

  it("no offer when user continued in same chat", () => {
    const cand = detectUnresolvedThread({
      chatId: "past1",
      title: "Парсинг Hermes",
      updatedAt: now - day,
      nowMs: now,
      unresolvedMinAgeSec: 86400,
      query: "парсинг",
      idleScan: true,
      tail: [
        { role: "user", content: "Как обойти лимит?", created_at: now - 2 * day },
        { role: "assistant", content: "Батчинг.", created_at: now - 2 * day + 1000 },
        { role: "user", content: "а что с rate limit?", created_at: now - day },
      ],
    });
    expect(cand).toBeNull();
  });

  it("idle scan allows unresolved without overlap", () => {
    const cand = detectUnresolvedThread({
      chatId: "past1",
      title: "Парсинг Hermes",
      updatedAt: now - 2 * day,
      nowMs: now,
      unresolvedMinAgeSec: 86400,
      query: "погода в сочи",
      idleScan: true,
      tail: [
        { role: "user", content: "Как обойти лимит парсинга Hermes?", created_at: now - 2 * day },
        { role: "assistant", content: "Батчинг.", created_at: now - 2 * day + 1000 },
      ],
    });
    expect(cand?.reasonCode).toBe("unresolved_thread");
  });
});

describe("lexicalOverlapScore", () => {
  it("scores related digests above unrelated", () => {
    const q = "RAG versus fine-tuning for local data";
    const related = "Архитектура агента: локальность данных, RAG vs fine-tune";
    const unrelated = "Рецепт борща и список покупок";
    expect(lexicalOverlapScore(q, related)).toBeGreaterThan(lexicalOverlapScore(q, unrelated));
  });

  it("soft overlap requires shared tokens", () => {
    expect(hasSoftTopicalOverlap("парсинг hermes лимит", "Hermes parsing rate limit")).toBe(true);
    expect(hasSoftTopicalOverlap("погода сочи", "Hermes parsing rate limit")).toBe(false);
  });
});

describe("buildInsightQuery", () => {
  it("includes page title and key", () => {
    const q = buildInsightQuery({
      userText: "Что лучше?",
      pageTitle: "RAG vs fine-tuning",
      pageKey: "https://example.com/rag",
    });
    expect(q).toContain("Что лучше?");
    expect(q).toContain("RAG vs fine-tuning");
    expect(q).toContain("example.com");
  });

  it("normalizes topic", () => {
    expect(normalizeInsightTopic("  Парсинг Hermes!!! ")).toMatch(/парсинг hermes/i);
  });
});
