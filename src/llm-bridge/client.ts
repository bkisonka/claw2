// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import type { Claw2Config } from "../config/types.js";

export type AuthorKind = "llm" | "human";

export interface ConversationMessage {
  id: string;
  conversationId: string;
  authorId: string;
  authorKind: AuthorKind;
  text: string;
  createdAt: number;
}

export interface LlmBridgeConfigResolved {
  baseUrl: string;
  agentId: string;
  conversationId: string;
  token: string;
  displayName: string;
  participantLabels: Record<string, string>;
}

export function resolveLlmBridgeConfig(config: Claw2Config): LlmBridgeConfigResolved | null {
  const b = config.llmBridge;
  if (b?.enabled !== true) return null;
  const baseUrl = (
    process.env.CLAW2_LLM_BRIDGE_URL?.trim() ||
    b.url?.trim() ||
    ""
  ).replace(/\/+$/, "");
  const agentId = (process.env.CLAW2_LLM_BRIDGE_AGENT_ID?.trim() || b.agentId?.trim() || "").trim();
  const conversationId = (
    process.env.CLAW2_LLM_BRIDGE_CONVERSATION_ID?.trim() ||
    b.conversationId?.trim() ||
    "default"
  ).trim();
  const token = (process.env.CLAW2_LLM_BRIDGE_TOKEN?.trim() || b.token?.trim() || "").trim();
  if (!baseUrl || !agentId || !conversationId) return null;
  const labels: Record<string, string> = { ...(b.participantLabels ?? {}) };
  const displayName = b.displayName?.trim() || agentId;
  labels[agentId] = displayName;
  return {
    baseUrl,
    agentId,
    conversationId,
    token,
    displayName,
    participantLabels: labels,
  };
}

export function isLlmBridgeEnabled(config: Claw2Config): boolean {
  return resolveLlmBridgeConfig(config) != null;
}

function authHeaders(token: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

export async function bridgeEnsureConversation(
  resolved: LlmBridgeConfigResolved,
  participantIds?: string[]
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${resolved.baseUrl}/api/v1/conversations`, {
      method: "POST",
      headers: authHeaders(resolved.token),
      body: JSON.stringify({
        id: resolved.conversationId,
        title: resolved.conversationId,
        participantIds: participantIds ?? [resolved.agentId],
      }),
    });
    if (res.status === 201 || res.status === 200) return { ok: true };
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function bridgePostMessage(
  resolved: LlmBridgeConfigResolved,
  authorId: string,
  authorKind: AuthorKind,
  text: string
): Promise<{ ok: boolean; message?: ConversationMessage; error?: string }> {
  try {
    const res = await fetch(
      `${resolved.baseUrl}/api/v1/conversations/${encodeURIComponent(resolved.conversationId)}/messages`,
      {
        method: "POST",
        headers: authHeaders(resolved.token),
        body: JSON.stringify({
          authorId,
          authorKind,
          text: text.trim(),
          participantIds: Object.keys(resolved.participantLabels),
        }),
      }
    );
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: ConversationMessage;
    };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true, message: data.message };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function bridgeFetchMessages(
  resolved: LlmBridgeConfigResolved,
  after: number,
  opts?: { all?: boolean; limit?: number }
): Promise<{ ok: boolean; messages: ConversationMessage[]; error?: string }> {
  const q = new URLSearchParams({
    after: String(after),
    limit: String(opts?.limit ?? 200),
  });
  if (opts?.all) q.set("all", "1");
  try {
    const res = await fetch(
      `${resolved.baseUrl}/api/v1/conversations/${encodeURIComponent(resolved.conversationId)}/messages?${q}`,
      { headers: authHeaders(resolved.token) }
    );
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      messages?: ConversationMessage[];
    };
    if (!res.ok) return { ok: false, messages: [], error: data.error || `HTTP ${res.status}` };
    return { ok: true, messages: Array.isArray(data.messages) ? data.messages : [] };
  } catch (e) {
    return { ok: false, messages: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export async function bridgeFetchAllMessages(
  resolved: LlmBridgeConfigResolved
): Promise<{ ok: boolean; messages: ConversationMessage[]; error?: string }> {
  return bridgeFetchMessages(resolved, 0, { all: true, limit: 500 });
}
