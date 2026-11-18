/**
 * web_fetch tool: GET by URL; HTML → readable text, then Content Boundary.
 * SSRF guard: every hop (initial URL and each redirect) is checked against
 * private/internal destinations — see security/url-guard.ts.
 */
import type { Claw2Config } from "../config/types.js";
import { wrapExternalContent } from "../security/content-boundary.js";
import { filterExternalResponse } from "../security/external-content-filters.js";
import { assertPublicUrl } from "../security/url-guard.js";
import { htmlToText, looksLikeHtml, truncateText } from "./html-to-text.js";
import { throwIfAborted } from "../core/abort.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_MAX_CONTEXT_CHARS = 8_000;
const MAX_REDIRECTS = 5;

export async function toolWebFetch(
  config: Claw2Config,
  url: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; content?: string; error?: string }> {
  throwIfAborted(signal);
  if (!url || typeof url !== "string") return { ok: false, error: "url required" };
  const trimmed = url.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    return { ok: false, error: "only http and https URLs allowed" };
  }
  const timeoutMs = config.tools?.webFetch?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = config.tools?.webFetch?.maxBodyBytes ?? DEFAULT_MAX_BYTES;
  const maxContextChars = config.tools?.webFetch?.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;
  const allowPrivate = config.tools?.webFetch?.allowPrivateHosts === true;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const fetchSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;

  try {
    // Manual redirect loop: the guard runs on the initial URL and on every
    // hop, so a public page cannot bounce fetches into internal addresses.
    let currentUrl = trimmed;
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const guard = await assertPublicUrl(currentUrl, allowPrivate);
      if (!guard.ok) return { ok: false, error: guard.error };
      const resp = await fetch(currentUrl, {
        method: "GET",
        signal: fetchSignal,
        redirect: "manual",
        headers: { Accept: "text/html, text/plain, application/json;q=0.9, */*;q=0.8" },
      });
      throwIfAborted(signal);
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get("location");
        if (!loc) {
          res = resp;
          break;
        }
        let next: URL;
        try {
          next = new URL(loc, currentUrl);
        } catch {
          return { ok: false, error: `invalid redirect target: ${loc.slice(0, 200)}` };
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          return { ok: false, error: "only http and https redirect targets allowed" };
        }
        currentUrl = next.toString();
        continue;
      }
      res = resp;
      break;
    }
    if (!res) {
      return { ok: false, error: `too many redirects (max ${MAX_REDIRECTS})` };
    }
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
    }
    const buf = await res.arrayBuffer();
    throwIfAborted(signal);
    if (buf.byteLength > maxBytes) {
      return { ok: false, error: `response too large (max ${maxBytes} bytes)` };
    }
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    const contentType = res.headers.get("content-type");
    let text = looksLikeHtml(raw, contentType)
      ? htmlToText(raw, maxContextChars)
      : truncateText(raw, maxContextChars);
    const filtered = filterExternalResponse(text);
    const wrapped = wrapExternalContent(filtered, { source: "web" });
    return { ok: true, content: wrapped };
  } catch (err) {
    throwIfAborted(signal);
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("abort")) return { ok: false, error: "timeout" };
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
}
