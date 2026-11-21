// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { apiBase, apiKey } from "../config";

/** Agent run rating (for evolution): 1 — like, 0 — dislike */
export async function rateRun(runId: number, rating: 0 | 1): Promise<{ ok: boolean; error?: string }> {
  const url = `${apiBase}/api/agent-selection/rate`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ runId, rating }),
  });
  const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
  if (!res.ok) {
    return { ok: false, error: data.error || `HTTP ${res.status}` };
  }
  return { ok: data.ok === true, error: data.error };
}
