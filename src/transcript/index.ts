// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import type { Claw2Config } from "../config/types.js";
import type { ChatRepository } from "../gateway/db/chat-repository.js";
import type { TranscriptSessionAccess } from "./types.js";

export type {
  TranscriptSearchHit,
  TranscriptMessage,
  TranscriptListItem,
  TranscriptListResult,
  TranscriptListOptions,
  TranscriptReadResult,
  TranscriptReadOptions,
  TranscriptSessionAccess,
} from "./types.js";

export {
  TRANSCRIPT_SEARCH_DEFAULT_LIMIT,
  TRANSCRIPT_SEARCH_MAX_LIMIT,
  TRANSCRIPT_LIST_DEFAULT_LIMIT,
  TRANSCRIPT_LIST_MAX_LIMIT,
  TRANSCRIPT_MAX_TOOL_CALLS_PER_TURN,
} from "./types.js";

export { buildTranscriptTocBlock, buildTranscriptListFirstPageBlock } from "./toc.js";
export { transcriptPreview } from "./preview.js";

export function isTranscriptToolsEnabled(config: Claw2Config): boolean {
  if (config.gateway?.transcriptTools === false) return false;
  return !!config.gateway?.chatsDbPath?.trim();
}

export function createTranscriptSessionAccess(
  repo: ChatRepository,
  chatId: string,
  userId: string
): TranscriptSessionAccess {
  return {
    search: (query, limit) => repo.searchTranscript(chatId, userId, query, limit),
    list: (options) => repo.listTranscript(chatId, userId, options),
    read: (options) => repo.readTranscript(chatId, userId, options),
  };
}
