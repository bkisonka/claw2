// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { apiBase, apiKey } from "../config";

function headers(): HeadersInit {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) h["X-Api-Key"] = apiKey;
  return h;
}

export type BrowserSearchHit = {
  title: string;
  url: string;
  snippet: string;
};

export type BrowserSearchResult =
  | { ok: true; provider?: string; hits: BrowserSearchHit[]; markdown: string }
  | { ok: false; error: string; provider?: string };

/** Direct toolSearch (no LLM) for address-bar search in browse mode. */
export async function browserSearch(query: string): Promise<BrowserSearchResult> {
  const res = await fetch(`${apiBase}/api/browser/search`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ query }),
  });
  const data = (await res.json().catch(() => ({}))) as BrowserSearchResult & { error?: string };
  if (!res.ok) {
    return { ok: false, error: data.error || `HTTP ${res.status}` };
  }
  if (!data.ok) {
    return { ok: false, error: data.error || "Search failed", provider: data.provider };
  }
  return {
    ok: true,
    provider: data.provider,
    hits: Array.isArray(data.hits) ? data.hits : [],
    markdown: typeof data.markdown === "string" ? data.markdown : "",
  };
}
