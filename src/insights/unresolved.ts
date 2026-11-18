import type { ChatMessageTailItem } from "../gateway/db/chat-repository.js";
import { hasSoftTopicalOverlap } from "./score.js";
import { normalizeInsightTopic } from "./query.js";
import type { InsightCandidate } from "./types.js";

/** Closing markers: whole-message or word-boundary; ultra-short "ok" only as whole message. */
const CLOSING_WHOLE =
  /^(ok|ок|okay|окей|thanks|thank you|спасибо|сработало|помогло|решили|закрыли|done|fixed|works|got it|понял|понятно|отлично)[.!?]?$/iu;

const CLOSING_PHRASE =
  /\b(спасибо|сработало|помогло|решили|закрыли|thanks|thank you|works for me|all good|всё\s+ок|все\s+ок|разобрались)\b/iu;

export function isClosingUserMessage(content: string): boolean {
  const t = content.replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (t.length <= 12 && CLOSING_WHOLE.test(t)) return true;
  if (t.length < 40 && CLOSING_PHRASE.test(t) && !/[?]/.test(t)) return true;
  if (CLOSING_WHOLE.test(t)) return true;
  return false;
}

export interface UnresolvedCheckInput {
  chatId: string;
  title: string;
  updatedAt: number;
  tail: ChatMessageTailItem[];
  nowMs: number;
  unresolvedMinAgeSec: number;
  query: string;
  idleScan?: boolean;
}

/**
 * Detect unresolved_thread from chat tail.
 * Returns candidate or null.
 */
export function detectUnresolvedThread(input: UnresolvedCheckInput): InsightCandidate | null {
  const { tail, nowMs, unresolvedMinAgeSec, query, idleScan } = input;
  if (!tail.length) return null;

  let lastAsstIdx = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail[i]!.role === "assistant") {
      lastAsstIdx = i;
      break;
    }
  }
  if (lastAsstIdx < 0) return null;

  const lastAsst = tail[lastAsstIdx]!;
  const ageSec = (nowMs - lastAsst.created_at) / 1000;
  if (ageSec < unresolvedMinAgeSec) return null;

  const afterUser = tail.slice(lastAsstIdx + 1).filter((m) => m.role === "user");
  if (afterUser.length > 0) {
    // User returned to this chat — not an abandoned unresolved offer for another session
    return null;
  }

  let lastUserBefore: ChatMessageTailItem | null = null;
  for (let i = lastAsstIdx - 1; i >= 0; i--) {
    if (tail[i]!.role === "user") {
      lastUserBefore = tail[i]!;
      break;
    }
  }
  if (!lastUserBefore) return null;
  if (isClosingUserMessage(lastUserBefore.content)) return null;

  const haystack = `${input.title}\n${lastUserBefore.content}\n${lastAsst.content}`;
  if (!idleScan && query.trim() && !hasSoftTopicalOverlap(query, haystack)) return null;

  const topic = normalizeInsightTopic(input.title || lastUserBefore.content.slice(0, 60));
  const excerpts = [
    lastUserBefore.content.replace(/\s+/g, " ").trim().slice(0, 220),
    lastAsst.content.replace(/\s+/g, " ").trim().slice(0, 220),
  ].filter(Boolean);

  return {
    reasonCode: "unresolved_thread",
    pastChatId: input.chatId,
    pastChatTitle: (input.title || "Chat").trim() || "Chat",
    pastChatUpdatedAt: input.updatedAt,
    score: Math.min(0.95, 0.7 + Math.min(0.2, ageSec / (unresolvedMinAgeSec * 7))),
    insightTopic: topic || "unresolved",
    excerpts,
  };
}
