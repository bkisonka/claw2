/** Normalize page URLs for “one chat per page” (browser tab ↔ session). */

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "utm_name",
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "ref",
  "referrer",
  "source",
  "_ga",
  "_gl",
  "yclid",
]);

/**
 * Stable page key from a URL, or null for about:blank / invalid / non-http(s).
 * Strips hash, www., and common tracking query params.
 */
export function normalizePageKey(raw: string): string | null {
  const s = String(raw || "").trim();
  if (!s || s === "about:blank") return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    let host = u.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    const path = u.pathname || "/";
    const params = new URLSearchParams(u.search);
    for (const key of [...params.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) {
        params.delete(key);
      }
    }
    const qs = params.toString();
    const port =
      u.port && u.port !== "80" && u.port !== "443" && u.port !== ""
        ? `:${u.port}`
        : "";
    return `${u.protocol}//${host}${port}${path}${qs ? `?${qs}` : ""}`;
  } catch {
    return null;
  }
}

/** Short label for sidebar / titles. */
export function pageKeyLabel(pageKey: string, pageTitle?: string): string {
  const title = (pageTitle || "").trim();
  if (title && title !== "about:blank") return title.slice(0, 80);
  try {
    const u = new URL(pageKey);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.host}${path}`.slice(0, 80);
  } catch {
    return pageKey.slice(0, 80);
  }
}
