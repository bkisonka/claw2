// SPDX-License-Identifier: AGPL-3.0-or-later
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

export interface AgentItem {
  name: string;
  description: string;
  /** Call/In/Out from the skill header — how to invoke. */
  help?: string;
  usageComplete?: boolean;
  enabled: boolean;
}

export interface AgentsResponse {
  agents: AgentItem[];
  skillsAllowlist: string[];
  disabledAgents: string[];
}

async function readError(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  return (data as { error?: string }).error || `HTTP ${res.status}`;
}

export async function listAgents(): Promise<AgentsResponse> {
  const res = await fetch(`${apiBase}/api/agents`, { headers: headers() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as AgentsResponse;
}

export async function setAgentEnabled(name: string, enabled: boolean): Promise<void> {
  const res = await fetch(`${apiBase}/api/agents`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ name, enabled }),
  });
  if (!res.ok) throw new Error(await readError(res));
}

export async function deleteAgent(name: string): Promise<void> {
  const res = await fetch(`${apiBase}/api/agents?name=${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: headers(),
  });
  if (!res.ok) throw new Error(await readError(res));
}

export async function createAgent(input: {
  name: string;
  description?: string;
  content?: string;
}): Promise<{ name: string }> {
  const res = await fetch(`${apiBase}/api/agents`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as { name?: string };
  return { name: data.name || input.name };
}

export async function putSkillsAllowlist(allowlist: string[]): Promise<string[]> {
  const res = await fetch(`${apiBase}/api/skills`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ allowlist }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as { allowlist?: string[] };
  return Array.isArray(data.allowlist) ? data.allowlist : allowlist;
}
