// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import type { Claw2Config } from "../config/types.js";
import {
  bridgeFetchAllMessages,
  bridgePostMessage,
  resolveLlmBridgeConfig,
} from "../llm-bridge/client.js";

export async function toolRoomSend(
  config: Claw2Config,
  text: string
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const resolved = resolveLlmBridgeConfig(config);
  if (!resolved) {
    return { ok: false, error: "LLM room not configured (llmBridge.enabled, url, agentId, conversationId)" };
  }
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "text is required" };
  const result = await bridgePostMessage(resolved, resolved.agentId, "llm", trimmed);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, messageId: result.message?.id };
}

export async function toolRoomHistory(
  config: Claw2Config
): Promise<{ ok: boolean; content?: string; error?: string }> {
  const resolved = resolveLlmBridgeConfig(config);
  if (!resolved) return { ok: false, error: "LLM room not configured" };
  const all = await bridgeFetchAllMessages(resolved);
  if (!all.ok) return { ok: false, error: all.error };
  const lines = all.messages.map((m) => {
    const label = resolved.participantLabels[m.authorId] ?? m.authorId;
    const kind = m.authorKind === "human" ? "Human" : "LLM";
    return `[${label} (${kind})]: ${m.text}`;
  });
  return {
    ok: true,
    content: lines.length ? lines.join("\n\n") : "There are no messages in the room yet.",
  };
}
