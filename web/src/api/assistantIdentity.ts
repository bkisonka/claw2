// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { apiBase, apiKey } from "../config";
import { getAuthHeaders } from "../auth/storage";

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", ...getAuthHeaders() };
  if (apiKey) {
    h["X-API-Key"] = apiKey;
    if (!h["Authorization"]) h["Authorization"] = `Bearer ${apiKey}`;
  }
  return h;
}

export type AssistantAvatar =
  | { kind: "preset"; value: string }
  | { kind: "image"; mimeType: string; dataBase64: string };

export type AssistantIdentityPayload = {
  name?: string;
  avatar: { kind: "preset"; value: string } | { kind: "image"; mimeType: string; dataUrl: string };
  /** Avatar diameter in px; emoji scales proportionally on the client. */
  avatarSize: number;
  isDefault: boolean;
};

export async function getAssistantIdentity(): Promise<AssistantIdentityPayload> {
  const res = await fetch(`${apiBase}/api/assistant-identity`, { headers: headers() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  return (await res.json()) as AssistantIdentityPayload;
}

export async function putAssistantIdentity(body: {
  name?: string;
  avatar?: AssistantAvatar | null;
  avatarSize?: number;
}): Promise<AssistantIdentityPayload> {
  const res = await fetch(`${apiBase}/api/assistant-identity`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  return (await res.json()) as AssistantIdentityPayload;
}
