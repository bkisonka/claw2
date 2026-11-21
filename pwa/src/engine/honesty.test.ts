// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it } from "vitest";
import {
  honestyPolicyBlock,
  verifyPrompt,
  unwrapVerifierText,
  runVerification,
  type HonestyEvidence,
  type VerifierChat,
} from "./honesty";

describe("honesty policy block", () => {
  it("includes grounding, refusal and no-fake-sources rules", () => {
    const block = honestyPolicyBlock();
    expect(block).toContain("web_search");
    expect(block).toContain("не знаю");
    expect(block).toContain("Не выдумывай");
    expect(block).toContain("память");
  });
});

describe("verifyPrompt", () => {
  it("embeds question, draft and evidence blocks", () => {
    const evidence: HonestyEvidence[] = [
      { tool: "web_search", content: "Результат поиска: столица Франции — Париж." },
      { tool: "recall", content: "Пользователь живёт в Париже." },
    ];
    const p = verifyPrompt({ question: "Какая столица Франции?", draft: "Столица — Лион.", evidence });
    expect(p).toContain("Какая столица Франции?");
    expect(p).toContain("Столица — Лион.");
    expect(p).toContain("### web_search");
    expect(p).toContain("### recall");
    expect(p).toContain("Париж");
    expect(p).toContain("БЕЗ изменений");
  });

  it("renders empty evidence section when nothing was gathered", () => {
    const p = verifyPrompt({ question: "q", draft: "d", evidence: [] });
    expect(p).toContain("### СВИДЕТЕЛЬСТВА");
    expect(p).toContain("(нет — ни инструментов");
  });
});

describe("unwrapVerifierText", () => {
  it("returns plain text unchanged", () => {
    expect(unwrapVerifierText("Простой ответ")).toBe("Простой ответ");
  });

  it("unwraps markdown fences with language tag", () => {
    expect(unwrapVerifierText("```text\nОтвет в ограде\n```")).toBe("Ответ в ограде");
    expect(unwrapVerifierText("```\nБез тега\n```")).toBe("Без тега");
  });

  it("trims whitespace", () => {
    expect(unwrapVerifierText("  x  ")).toBe("x");
  });

  it("returns null for empty output", () => {
    expect(unwrapVerifierText("")).toBeNull();
    expect(unwrapVerifierText("```text\n\n```")).toBeNull();
  });
});

describe("runVerification", () => {
  const evidence: HonestyEvidence[] = [{ tool: "web_search", content: "Париж." }];

  it("returns changed result when the verifier rewrites the draft", async () => {
    const chat: VerifierChat = async () => ({ content: "Исправленный текст." });
    const res = await runVerification({
      question: "q",
      draft: "Черновик.",
      evidence,
      chat,
    });
    expect(res).toEqual({ text: "Исправленный текст.", changed: true });
  });

  it("returns changed=false when the verifier keeps the draft", async () => {
    const chat: VerifierChat = async () => ({ content: "Черновик." });
    const res = await runVerification({ question: "q", draft: "Черновик.", evidence, chat });
    expect(res).toEqual({ text: "Черновик.", changed: false });
  });

  it("unwraps fenced verifier output", async () => {
    const chat: VerifierChat = async () => ({ content: "```text\nНовый текст.\n```" });
    const res = await runVerification({ question: "q", draft: "Старый текст.", evidence, chat });
    expect(res?.text).toBe("Новый текст.");
    expect(res?.changed).toBe(true);
  });

  it("returns null on verifier failure (draft is preserved)", async () => {
    const chat: VerifierChat = async () => {
      throw new Error("LLM down");
    };
    const res = await runVerification({ question: "q", draft: "Черновик.", evidence, chat });
    expect(res).toBeNull();
  });

  it("returns null for empty draft without calling the verifier", async () => {
    let called = 0;
    const chat: VerifierChat = async () => {
      called += 1;
      return { content: "x" };
    };
    const res = await runVerification({ question: "q", draft: "   ", evidence, chat });
    expect(res).toBeNull();
    expect(called).toBe(0);
  });
});
