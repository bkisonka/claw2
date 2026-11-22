// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Signed-token access for /files: browser media loads (<img>/<audio>/<a>)
 * cannot send API-key/JWT headers, so the gateway issues a short-lived HMAC
 * token (GET /api/files-token) that authenticated clients append to /files
 * URLs (query param k). The token is cached and refreshed at ~2/3 TTL.
 * Signing is synchronous from cache: the first render of a session may use an
 * unsigned URL (401 → media retry logic re-renders once the token arrives).
 */
import { apiBase, apiKey } from "../config";
import { getAuthHeaders } from "../auth/storage";

interface FilesToken {
  k: string;
  exp: number;
}

let cached: FilesToken | null = null;
let inflight: Promise<string> | null = null;

function authedHeaders(): Record<string, string> {
  const headers: Record<string, string> = { ...getAuthHeaders() };
  if (apiKey && !headers["Authorization"]) headers["Authorization"] = `Bearer ${apiKey}`;
  if (apiKey) headers["X-API-Key"] = apiKey;
  return headers;
}

async function fetchToken(): Promise<string> {
  const res = await fetch(`${apiBase}/api/files-token`, { headers: authedHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { k?: string; exp?: number };
  if (!data.k || typeof data.exp !== "number") throw new Error("bad token payload");
  cached = { k: data.k, exp: data.exp };
  return cached.k;
}

/** Current token, refetching in the background when missing/stale. Sync value only. */
export function currentFilesToken(): string | null {
  const now = Date.now();
  if (cached && cached.exp - now > 3 * 60_000) return cached.k;
  if (!inflight) {
    inflight = fetchToken()
      .catch(() => "")
      .finally(() => {
        inflight = null;
      });
  }
  return cached && cached.exp > now ? cached.k : null;
}

/** Append the token to a /files URL (other URLs pass through untouched). */
export function signFilesUrl(url: string): string {
  if (!url || !url.includes("/files/")) return url;
  const k = currentFilesToken();
  if (!k) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}k=${encodeURIComponent(k)}`;
}
