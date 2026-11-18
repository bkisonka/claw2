import { apiBase, apiKey } from "../config";
import { getAuthHeaders } from "../auth/storage";

export interface LlmRoomMessage {
  id: string;
  conversationId: string;
  authorId: string;
  authorKind: "llm" | "human";
  text: string;
  createdAt: number;
}

export interface LlmRoomInfo {
  enabled: boolean;
  conversationId: string;
  localAgentId: string;
  displayName: string;
  participantLabels: Record<string, string>;
  humanAuthorId: string;
  humanLabel: string;
  /** all | mention — local-instance mode as seen by the gateway */
  autoReplyMode?: "all" | "mention";
  /** Hint for @mentions (all LLMs in the room) */
  mentionAliases?: string[];
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", ...getAuthHeaders() };
  if (apiKey) {
    h["X-API-Key"] = apiKey;
    if (!h["Authorization"]) h["Authorization"] = `Bearer ${apiKey}`;
  }
  return h;
}

export async function fetchLlmRoomInfo(): Promise<LlmRoomInfo | null> {
  const res = await fetch(`${apiBase}/api/llm-room/info`, { headers: headers() });
  if (res.status === 503) return null;
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  return (await res.json()) as LlmRoomInfo;
}

export async function fetchLlmRoomMessages(after = 0, all = false): Promise<LlmRoomMessage[]> {
  const q = new URLSearchParams({ after: String(after) });
  if (all) q.set("all", "1");
  const res = await fetch(`${apiBase}/api/llm-room/messages?${q}`, { headers: headers() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  const data = (await res.json()) as { messages?: LlmRoomMessage[] };
  return Array.isArray(data.messages) ? data.messages : [];
}

export async function postLlmRoomMessage(text: string): Promise<LlmRoomMessage> {
  const res = await fetch(`${apiBase}/api/llm-room/messages`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ text: text.trim() }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: LlmRoomMessage };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  if (!data.message) throw new Error("No message in response");
  return data.message;
}
