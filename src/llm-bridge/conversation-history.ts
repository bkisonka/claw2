import { wrapExternalContent } from "../security/content-boundary.js";

export interface RoomMessage {
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

/**
 * Full room feed → history + last message as the current move (as in a chat with a user).
 */
export function buildOrchestratorTurn(
  messages: RoomMessage[],
  selfAgentId: string,
  labels: Record<string, string>
): { history: SessionTurn[]; userMessage: string } {
  if (messages.length === 0) {
    return { history: [], userMessage: "" };
  }
  const prior = messages.slice(0, -1);
  const last = messages[messages.length - 1];
  const history: SessionTurn[] = prior.map((m) => {
    if (m.authorId === selfAgentId) {
      return { role: "assistant", content: m.text };
    }
    return { role: "user", content: formatOtherMessage(m, labels) };
  });
  const userMessage =
    last.authorId === selfAgentId
      ? last.text
      : formatOtherMessage(last, labels);
  return { history, userMessage };
}
