// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { apiBase, apiKey } from "../config";
import { getAuthHeaders } from "../auth/storage";

export type ConnectionState = "ok" | "error" | "off";

export type ConnectionCheck = {
  id: string;
  status: ConnectionState;
  detail?: string;
  error?: string;
};

export type ConnectionsStatus = {
  checkedAt: string;
  connections: ConnectionCheck[];
  onboarding?: {
    needsLlmSetup: boolean;
    reason?: string;
  };
};

function headers(): Record<string, string> {
  const h: Record<string, string> = { ...getAuthHeaders() };
  if (apiKey) {
    h["X-API-Key"] = apiKey;
    if (!h["Authorization"]) h["Authorization"] = `Bearer ${apiKey}`;
  }
  return h;
}

export async function fetchConnectionsStatus(): Promise<ConnectionsStatus> {
  const res = await fetch(`${apiBase}/api/connections/status`, { headers: headers() });
  const data = (await res.json().catch(() => ({}))) as ConnectionsStatus & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return {
    checkedAt: data.checkedAt || new Date().toISOString(),
    connections: Array.isArray(data.connections) ? data.connections : [],
    onboarding: data.onboarding,
  };
}

export function connectionMap(status: ConnectionsStatus | null): Record<string, ConnectionCheck> {
  const out: Record<string, ConnectionCheck> = {};
  if (!status) return out;
  for (const c of status.connections) out[c.id] = c;
  return out;
}
