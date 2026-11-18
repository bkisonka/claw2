import type { IncomingMessage } from "node:http";

/**
 * CORS Allow-Origin for a request.
 * Hosted/multi-user: `*` (current behaviour).
 * Desktop (`CLAW2_DESKTOP=1`): only loopback http(s) (Electron UI / Vite hot).
 * Do not echo `null` / file: / app: — that would let a local HTML page call the
 * unauthenticated gateway. Opening chat links uses shell.openExternal and is unaffected.
 */
export function resolveCorsAllowOrigin(req: IncomingMessage): string {
  if (process.env.CLAW2_DESKTOP !== "1") return "*";
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
