/**
 * Build UDP-safe SIP dial URIs for the Node media backend (udp:true, tcp:false).
 *
 * @vexyl.ai/sip resolves hosts via NAPTR/SRV and may return TCP/TLS/SCTP.
 * Opening those with a UDP-only transport throws and can crash the process:
 *   TypeError: Cannot read properties of undefined (reading 'open')
 */

export type SipUriParts = {
  schema?: string;
  user?: string;
  host: string;
  port?: number;
  params?: Record<string, string | undefined>;
};

export type DialUriBuild = {
  /** Request-URI — sent to the registrar/proxy over UDP. */
  requestUri: string;
  /** To header — callee AOR on the PBX domain. */
  toUri: string;
};

function stripSipScheme(raw: string): string {
  return raw.replace(/^sips?:/i, "").trim();
}

/** Append/replace `;transport=udp` without duplicating other params. */
export function ensureUdpTransport(uri: string): string {
  const raw = uri.trim();
  if (!raw) return raw;
  const [base, ...rest] = raw.split(";");
  const params = rest
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !/^transport=/i.test(p));
  params.push("transport=udp");
  return `${base};${params.join(";")}`;
}

/**
 * Normalize a user-facing dial target to a SIP URI on `domain`.
 * Does not yet force proxy host/port — see {@link buildOutboundDialTarget}.
 */
export function normalizeTargetUri(to: string, domain: string): string {
  const raw = to.trim();
  if (!raw) throw new Error("Empty call target");
  if (/^sips?:/i.test(raw)) return ensureUdpTransport(raw);
  if (raw.includes("@")) return ensureUdpTransport(`sip:${raw}`);
  if (!domain) throw new Error("SIP domain is not configured");
  return ensureUdpTransport(`sip:${raw}@${domain}`);
}

function extractUser(uriOrTarget: string): string {
  const noScheme = stripSipScheme(uriOrTarget.split(";")[0] ?? uriOrTarget);
  const at = noScheme.indexOf("@");
  if (at > 0) return noScheme.slice(0, at);
  return noScheme;
}

/**
 * Route INVITE via the configured SIP server:port over UDP.
 * Request-URI host is the registrar (avoids NAPTR TCP on the domain);
 * To stays on the PBX domain AOR.
 */
export function buildOutboundDialTarget(opts: {
  to: string;
  domain: string;
  server: string;
  port: number;
}): DialUriBuild {
  const server = opts.server.trim();
  if (!server) throw new Error("SIP server is not configured");
  const port =
    Number.isFinite(opts.port) && opts.port > 0 && opts.port <= 65535 ? Math.floor(opts.port) : 5060;

  const toUri = normalizeTargetUri(opts.to, opts.domain);
  const user = extractUser(toUri);
  if (!user) throw new Error("Empty call target user");

  // Always include an explicit port so the stack skips NAPTR and only does A/AAAA.
  const requestUri = ensureUdpTransport(`sip:${user}@${server}:${port}`);
  return { requestUri, toUri };
}
