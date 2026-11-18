/**
 * SSRF guard for outbound tool fetches: block loopback, private, link-local,
 * CGNAT, benchmarking, multicast and reserved destinations.
 *
 * Checked in two layers: literal IP forms directly, and — for hostnames —
 * every address the name resolves to (a public-looking name that answers
 * with 127.0.0.1 or 169.254.169.254 is still denied). Redirect targets are
 * re-checked by the caller (manual redirect loop in web-fetch).
 *
 * Known limit (documented): the check runs before fetch(), so a hostile DNS
 * server answering differently per query (classic rebinding TOCTOU) can slip
 * through. A connect-time check inside the HTTP client would close that.
 */
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export type UrlGuardResult = { ok: true } | { ok: false; error: string };

/** Numeric form of a dotted-quad IPv4, or null when `ip` is not one. */
function v4ToNum(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** True for addresses that must not be reachable from tool fetches. */
function isPrivateV4(n: number): boolean {
  const a = n >>> 24;
  const b = (n >>> 16) & 0xff;
  const c = (n >>> 8) & 0xff;
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local (cloud metadata lives here)
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16/12
  if (a === 192 && b === 168) return true; // private 192.168/16
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** Expand an IPv6 literal (incl. `::` compression and dotted v4 tails) to 8 groups. */
function expandV6(low: string): number[] | null {
  let s = low;
  const v4m = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4m) {
    const n = v4ToNum(v4m[1]);
    if (n === null) return null;
    s = s.slice(0, s.length - v4m[1].length) + ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const groups = [...left];
  if (halves.length === 2) {
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    for (let i = 0; i < missing; i++) groups.push("0");
  }
  groups.push(...right);
  if (groups.length !== 8) return null;
  return groups.map((g) => {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return NaN;
    return parseInt(g, 16);
  });
}

function privateV6(host: string): boolean {
  const g = expandV6(host.toLowerCase());
  if (!g || g.some((x) => Number.isNaN(x))) return true; // unparseable form — deny defensively
  if (g.every((x) => x === 0)) return true; // ::
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1) {
    return true; // ::1 loopback
  }
  // IPv4-mapped/compatible tail (::ffff:a.b.c.d, ::a.b.c.d) — check embedded v4.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && (g[5] === 0 || g[5] === 0xffff)) {
    const n = g[6] * 65536 + g[7];
    if (isPrivateV4(n)) return true;
  }
  const w0 = g[0];
  if ((w0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((w0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  return false;
}

/**
 * Check a host that is already an IP literal. Returns a denial, or null when
 * the host is a public IP (or not an IP at all — caller resolves DNS then).
 */
function checkIpLiteral(host: string): UrlGuardResult | null {
  const kind = isIP(host);
  if (kind === 4) {
    const n = v4ToNum(host);
    if (n === null) return { ok: false, error: `invalid ip address: ${host}` };
    if (isPrivateV4(n)) return { ok: false, error: `blocked: private or internal address (${host})` };
    return null;
  }
  if (kind === 6) {
    if (privateV6(host)) return { ok: false, error: `blocked: private or internal address (${host})` };
    return null;
  }
  return null;
}

function hostnameIsInternal(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  );
}

/**
 * Guard a URL before fetching. `allowPrivate` (tools.webFetch.allowPrivateHosts)
 * turns the guard off for self-hosters who legitimately fetch their LAN services.
 */
export async function assertPublicUrl(rawUrl: string, allowPrivate = false): Promise<UrlGuardResult> {
  if (allowPrivate) return { ok: true };
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, error: "invalid url" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: "only http and https URLs allowed" };
  }
  const host = u.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (hostnameIsInternal(host)) {
    return { ok: false, error: `blocked: private or internal host (${host})` };
  }
  const literal = checkIpLiteral(host);
  if (literal) return literal;
  if (isIP(host) !== 0) return { ok: true };
  // Hostname: resolve and check every returned address.
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    return { ok: false, error: `dns lookup failed for ${host}` };
  }
  for (const { address } of addrs) {
    const r = checkIpLiteral(address.toLowerCase());
    if (r) return { ok: false, error: `${host} resolves to a private or internal address (${address})` };
  }
  return { ok: true };
}
