// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Credential boundary for signed file URLs: the short-lived file token may
 * only ride on URLs of the configured gateway's /files surface. A third-party
 * link that merely contains "/files/" must never carry the credential.
 */
export function isGatewayFilesUrl(rawUrl: string, base: string, pageUrl?: string): boolean {
  if (!rawUrl) return false;
  const effectiveBase = base || (typeof window !== "undefined" ? window.location.origin : "");
  if (!effectiveBase) return false;
  try {
    const u = new URL(rawUrl, pageUrl || effectiveBase);
    const b = new URL(effectiveBase);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.origin !== b.origin) return false;
    return u.pathname === "/files" || u.pathname.startsWith("/files/");
  } catch {
    return false;
  }
}
