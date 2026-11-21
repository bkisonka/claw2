// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Anti-hallucination layer ("обнуление вранья"): honesty policy in the system
 * prompt + a verification pass that re-reads the draft answer against the
 * evidence the agent actually gathered (tool outputs / memory recall).
 *
 * There is no external ground truth here — the verifier can only compare the
 * draft against the evidence in context and flag/refuse what it cannot support.
 * That is exactly the failure mode we target: confident invention of facts,
 * sources and citations with nothing behind them.
 */
import type { ChatMessage } from "./llm";
import { getSettings } from "./settings";

export type HonestyEvidence = {
  tool: string;
  content: string;
};

const EVIDENCE_SNIPPET_LIMIT = 1500;

/** System prompt policy: grounding, citations, explicit refusal, no fake sources. */
export function honestyPolicyBlock(): string {
  return [
    "Правила достоверности (обязательно):",
    "1. Фактические утверждения (факты, даты, числа, имена, цитаты, события) опирай только на: результаты инструментов (web_search/fetch_url), память (recall) или документы/сообщения в диалоге. Этого нет — так и скажи, что не знаешь, или предложи, как проверить.",
    "2. Не выдумывай источники: никогда не придумывай ссылки, названия статей/книг, имена исследователей и цитаты. Ссылка только та, что реально вернулась в результатах инструментов, и ты её процитировал в ответе.",
    "3. Числа и даты без источника в диалоге — помечай как приблизительные или опускай.",
    "4. Не уверен или данных мало — прямо скажи «не знаю / не могу проверить» и опиши, чего не хватает. Это нормальный ответ.",
    "5. Не скрывай разрыв между информацией из источников и своими предположениями: предположения помечай «предполагаю».",
    "6. Если вопрос про личные данные пользователя — отвечай только по фактам из памяти/диалога; их нет — признайся, что не помнишь.",
  ].join("\n");
}

/** Prompt shown to the verifier model. Exported for tests. */
export function verifyPrompt(opts: {
  question: string;
  draft: string;
  evidence: HonestyEvidence[];
}): string {
  const evidence = opts.evidence
    .map((e) => `### ${e.tool}\n${e.content.slice(0, EVIDENCE_SNIPPET_LIMIT)}`)
    .join("\n\n");
  return [
    "Ты — строгий верификатор ответов ассистента. Ниже вопрос пользователя, черновой ответ ассистента и свидетельства, собранные ассистентом (результаты инструментов, память, документы).",
    "",
    "Задача: сравнить КАЖДОЕ фактическое утверждение чернового ответа с этими свидетельствами. Утверждение допустимо, только если оно подтверждается свидетельствами или самим вопросом/диалогом (очевидные вещи — стиль, приветствия, рассуждения, инструкция — не трогай).",
    "",
    "Правила переписывания:",
    "- Неподтверждённое утверждение: убери или перепиши с пометкой «не подтверждено источниками».",
    "- Выдуманные ссылки, цитаты, имена, числа: удали или замени на реальные из свидетельств.",
    "- Стиль, структура, markdown,.inline-блоки [CELL …] и язык — сохрани.",
    "- Если всё подтверждено — верни черновой текст БЕЗ изменений, дословно.",
    "- Не добавляй своих фактов и не пиши мета-комментарий («как верификатор, я...»). Верни ТОЛЬКО итоговый текст ответа.",
    "",
    "### ВОПРОС ПОЛЬЗОВАТЕЛЯ",
    opts.question,
    "",
    "### ЧЕРНОВОЙ ОТВЕТ",
    opts.draft,
    "",
    "### СВИДЕТЕЛЬСТВА",
    evidence || "(нет — ни инструментов, ни памяти, ни документов; все факты вне общеизвестных выдуманы)",
    "",
    "### ИТОГОВЫЙ ОТВЕТ (только текст ответа, без пояснений):",
  ].join("\n");
}

/** Verifiers sometimes wrap the answer in fences/quotes — unwrap; empty → null. */
export function unwrapVerifierText(text: string): string | null {
  let t = text.trim();
  const fence = t.match(/^```[^\n]*\n([\s\S]*?)\n```\s*$/);
  if (fence && fence[1] !== undefined) t = fence[1].trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("«") && t.endsWith("»")))) {
    t = t.slice(1, -1).trim();
  }
  return t.length > 0 ? t : null;
}

export type VerificationResult = { text: string; changed: boolean };

export type VerifierChat = (opts: {
  messages: ChatMessage[];
  signal?: AbortSignal;
}) => Promise<{ content: string }>;

/** Default verifier channel: same LLM, no streaming deltas. */
export const defaultVerifierChat: VerifierChat = async ({ messages, signal }) => {
  const { chatStream } = await import("./llm");
  return chatStream({ messages, signal, onDelta: () => {} });
};

/**
 * Verification pass: re-read the draft against the gathered evidence.
 * Returns the corrected text (possibly unchanged) or null when verification
 * is not possible/failed (caller keeps the draft).
 */
export async function runVerification(opts: {
  question: string;
  draft: string;
  evidence: HonestyEvidence[];
  signal?: AbortSignal;
  chat?: VerifierChat;
}): Promise<VerificationResult | null> {
  const draft = opts.draft.trim();
  if (!draft) return null;
  const chat = opts.chat ?? defaultVerifierChat;
  const messages: ChatMessage[] = [{ role: "user", content: verifyPrompt(opts) }];
  try {
    const res = await chat({ messages, signal: opts.signal });
    const clean = unwrapVerifierText(res.content ?? "");
    if (!clean) return null;
    return { text: clean, changed: clean !== draft };
  } catch {
    // Verifier failure must never destroy the answer.
    return null;
  }
}

/** Should we verify this answer? Cheap preconditions only (cost: 1 extra call). */
export function verificationEnabled(): boolean {
  return getSettings().honesty.verifyAnswers;
}
