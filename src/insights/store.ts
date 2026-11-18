import type { ChatRepository } from "../gateway/db/chat-repository.js";
import type { InsightReasonCode } from "./types.js";

export function insightStoreHas(
  repo: ChatRepository,
  userId: string,
  pastChatId: string,
  reasonCode: InsightReasonCode,
  insightTopic: string
): boolean {
  return repo.hasInsightEvent(userId, pastChatId, reasonCode, insightTopic);
}

export function insightStoreRecordOffered(
  repo: ChatRepository,
  params: {
    userId: string;
    chatId: string;
    pastChatId: string;
    reasonCode: InsightReasonCode;
    insightTopic: string;
    score?: number;
    offerId?: string;
  }
): string {
  return repo.recordInsightEvent({
    id: params.offerId,
    userId: params.userId,
    chatId: params.chatId,
    pastChatId: params.pastChatId,
    status: "offered",
    insightTopic: params.insightTopic,
    reasonCode: params.reasonCode,
    score: params.score,
  });
}

export function insightStoreRecordDecision(
  repo: ChatRepository,
  params: {
    userId: string;
    chatId: string;
    pastChatId?: string | null;
    reasonCode: InsightReasonCode | string;
    insightTopic: string;
    score?: number;
    status: "accepted" | "dismissed";
  }
): string {
  return repo.recordInsightEvent({
    userId: params.userId,
    chatId: params.chatId,
    pastChatId: params.pastChatId,
    status: params.status,
    insightTopic: params.insightTopic,
    reasonCode: params.reasonCode,
    score: params.score,
  });
}

export function insightCooldownActive(
  repo: ChatRepository,
  chatId: string,
  userId: string,
  cooldownSec: number,
  nowMs = Date.now()
): boolean {
  if (cooldownSec <= 0) return false;
  const last = repo.lastInsightEventAt(chatId, userId);
  if (last == null) return false;
  return nowMs - last < cooldownSec * 1000;
}
