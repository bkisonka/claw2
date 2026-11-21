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

export type AssistantPersonaPayload = {
  full: string;
  compact: string;
  markdown?: string;
  path?: string;
  isDefault?: boolean;
};

export async function getAssistantPersona(): Promise<AssistantPersonaPayload> {
  const res = await fetch(`${apiBase}/api/assistant-persona`, { headers: headers() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  return (await res.json()) as AssistantPersonaPayload;
}

export async function putAssistantPersona(body: {
  full: string;
  compact?: string;
}): Promise<{ ok: boolean; full?: string; compact?: string; path?: string }> {
  const res = await fetch(`${apiBase}/api/assistant-persona`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    full?: string;
    compact?: string;
    path?: string;
  };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return { ok: !!data.ok, full: data.full, compact: data.compact, path: data.path };
}
