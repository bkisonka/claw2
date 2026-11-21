// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

export type InsightReasonCode =
  | "pattern"
  | "position_shift"
  | "solution_transfer"
  | "unresolved_thread";

export type InsightAskTemplateKey = "semantic_link" | "unresolved_return";

export interface InsightOffer {
  offerId: string;
  reasonCode: InsightReasonCode;
  pastChatId: string;
  pastChatTitle: string;
  pastChatUpdatedAt: number;
  score?: number;
  insightTopic: string;
  excerpts: string[];
  askTemplateKey: InsightAskTemplateKey;
  /** Filled in auto mode (or after accept via API) — formulated insight text */
  text?: string;
}

export interface ClientInsightContext {
  pastChatId: string;
  reasonCode: InsightReasonCode;
  insightTopic: string;
  excerpts: string[];
  currentBrief: string;
}

export interface InsightLinkerParams {
  userId: string;
  sessionId: string;
  userText: string;
  pageTitle?: string;
  pageKey?: string;
  projectId?: string | null;
  locale?: string;
  /** Idle scan: allow unresolved without topical overlap */
  idleScan?: boolean;
  nowMs?: number;
}

export interface InsightSiblingDigest {
  id: string;
  title: string;
  digest: string;
  updatedAt?: number;
}

export interface InsightCandidate {
  reasonCode: InsightReasonCode;
  pastChatId: string;
  pastChatTitle: string;
  pastChatUpdatedAt: number;
  score: number;
  insightTopic: string;
  excerpts: string[];
}
