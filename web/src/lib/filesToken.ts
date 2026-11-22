// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useEffect, useSyncExternalStore } from "react";
import { apiBase, apiKey } from "../config";
import { onStoredTokenChange } from "../auth/storage";
import { isGatewayFilesUrl } from "./gatewayUrl";
import { createFileGrantCache } from "./fileGrantCache";

// Only the personal gateway uses grants for requests without headers.
const grants = createFileGrantCache(async (path) => {
  const query = new URLSearchParams({ path });
  const res = await fetch(`${apiBase}/api/files-token?${query}`, {
    headers: apiKey ? { "X-API-Key": apiKey } : {},
    cache: "no-store",
    redirect: "error",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { k, exp } = await res.json() as { k?: string; exp?: number };
  if (!k || typeof exp !== "number") throw new Error("Invalid file grant");
  return { k, exp };
});

export const clearFilesToken = grants.clear;
onStoredTokenChange(clearFilesToken);
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === "claw2_token" || event.key === null) clearFilesToken();
  });
}

function grantUrl(raw: string): URL | null {
  const page = typeof window === "undefined" ? undefined : window.location.href;
  if (!page || !apiKey) return null;
  let base: URL;
  try { base = new URL(apiBase || page, page); } catch { return null; }
  // Resolve against the page, exactly as the element will; relative URLs may
  // otherwise be mistaken for gateway URLs in a split-origin deployment.
  if (!isGatewayFilesUrl(raw, base.origin, page)) return null;
  return new URL(raw, page);
}

function applyGrant(url: URL, k: string): string {
  url.searchParams.set("k", k);
  return url.href;
}

export function signFilesUrl(raw: string): string {
  const url = grantUrl(raw);
  const grant = url && grants.peek(url.pathname);
  return url && grant ? applyGrant(url, grant.k) : raw;
}

/** Refresh after mount; keep long-lived previews and gallery URLs usable. */
export function useFileGrantUrls(urls: string[]): void {
  useSyncExternalStore(grants.subscribe, grants.snapshot, grants.snapshot);
  const pathKey = JSON.stringify([...new Set(urls.map((raw) => grantUrl(raw)?.pathname).filter(Boolean))]);
  useEffect(() => {
    const paths = JSON.parse(pathKey) as string[];
    if (!paths.length) return;
    const refresh = () => { for (const path of paths) void grants.get(path); };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [pathKey]);
}

export function useSignedFilesUrl(raw: string): string {
  useFileGrantUrls([raw]);
  return signFilesUrl(raw);
}
