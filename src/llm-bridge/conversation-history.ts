// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { wrapExternalContent } from "../security/content-boundary.js";

export interface RoomMessage {
  id: string;
  authorId: string;
  authorKind: "llm" | "human";
  text: string;
}

export interface SessionTurn {
  role: "user" | "assistant";
  content: string;
}

function labelFor(authorId: string, labels: Record<string, string>): string {
  return labels[authorId]?.trim() || authorId;
}

function formatOtherMessage(m: RoomMessage, labels: Record<string, string>): string {
  const label = labelFor(m.authorId, labels);
  const wrapped = wrapExternalContent(m.text, {
    source: m.authorKind === "human" ? "llm-room-user" : "llm-room",
    sender: m.authorId,
  });
  return `[${label}]: ${wrapped}`;
}

/** Use the room's feed order, stopping at the exact event being handled. */
export function buildOrchestratorTurn(
  messages: readonly RoomMessage[],
  anchor: RoomMessage,
  selfAgentId: string,
  labels: Record<string, string>
): { history: SessionTurn[]; userMessage: string } {
  const index = messages.findIndex((m) => m.id === anchor.id);
  // An older event can fall outside the fetched window. Reply to the polled
  // event without room history rather than guessing which rows predate it.
  const prior = index < 0 ? [] : messages.slice(0, index);
  const history: SessionTurn[] = prior.map((m) => {
    if (m.authorId === selfAgentId) {
      return { role: "assistant", content: m.text };
    }
    return { role: "user", content: formatOtherMessage(m, labels) };
  });
  const userMessage =
    anchor.authorId === selfAgentId
      ? anchor.text
      : formatOtherMessage(anchor, labels);
  return { history, userMessage };
}
