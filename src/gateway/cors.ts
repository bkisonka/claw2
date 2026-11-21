// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import type { IncomingMessage } from "node:http";

/**
 * CORS Allow-Origin for a request.
 * Hosted/multi-user: `*` (current behaviour).
 * Desktop (`CLAW2_DESKTOP=1`): only loopback http(s) (Electron UI / Vite hot).
 * Do not echo `null` / file: / app: — that would let a local HTML page call the
 * unauthenticated gateway. Opening chat links uses shell.openExternal and is unaffected.
 *
 * `authEnabled` = gateway.auth enabled with a non-empty key. When auth is off,
 * no cross-origin grant is issued at all: any website in the user's browser
 * could otherwise read chats and rewrite the config cross-origin. Same-origin
 * clients (the web UI and PWA served by this gateway) do not need CORS.
 */
export function resolveCorsAllowOrigin(req: IncomingMessage, authEnabled = true): string {
  if (process.env.CLAW2_DESKTOP !== "1") {
    if (!authEnabled) return "https://claw2.invalid";
    return "*";
  }
  const raw = req.headers.origin;
  if (typeof raw !== "string" || !raw.trim()) {
    // Same-origin / Electron without Origin header — CORS not applied by browsers.
    return "http://127.0.0.1";
  }
  if (raw === "null") {
    // Opaque / file contexts: deny (literal ACAO "null" would allow them).
    return "https://claw2.invalid";
  }
  try {
    const u = new URL(raw);
    if (
      (u.protocol === "http:" || u.protocol === "https:") &&
      (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]")
    ) {
      return raw;
    }
  } catch {
    /* ignore */
  }
  // Non-loopback / non-http(s): do not reflect; sentinel never matches a real Origin.
  return "https://claw2.invalid";
}
