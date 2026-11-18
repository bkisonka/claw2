/**
 * Lightweight DuckDNS client: A-record and TXT update for ACME DNS-01.
 * API: https://www.duckdns.org/spec.jsp
 */

export interface DuckDnsUpdateResult {
  ok: boolean;
  raw: string;
  ip?: string;
}

export function normalizeDuckDnsDomain(input: string): { subdomain: string; fqdn: string } {
  const raw = input.trim().toLowerCase().replace(/\.$/, "");
  if (!raw) throw new Error("DuckDNS domain is empty");
  const withoutSuffix = raw.endsWith(".duckdns.org") ? raw.slice(0, -".duckdns.org".length) : raw;
  const subdomain = withoutSuffix.replace(/^\.+|\.+$/g, "");
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(subdomain)) {
    throw new Error(`Invalid DuckDNS subdomain: ${subdomain}`);
  }
  return { subdomain, fqdn: `${subdomain}.duckdns.org` };
}

async function duckDnsRequest(params: Record<string, string>): Promise<DuckDnsUpdateResult> {
  const url = new URL("https://www.duckdns.org/update");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url, { method: "GET" });
  const raw = (await res.text()).trim();
  const ok = raw.toLowerCase().startsWith("ok");
  return { ok, raw };
}

/** Update IP (empty ip = DuckDNS auto-detection).*/
export async function updateDuckDnsIp(opts: {
  domain: string;
  token: string;
  ip?: string;
}): Promise<DuckDnsUpdateResult> {
  const { subdomain } = normalizeDuckDnsDomain(opts.domain);
  const token = opts.token.trim();
  if (!token) throw new Error("DuckDNS token is empty");
  const params: Record<string, string> = {
    domains: subdomain,
    token,
    verbose: "true",
  };
  if (opts.ip?.trim()) params.ip = opts.ip.trim();
  const result = await duckDnsRequest(params);
  if (result.ok && result.raw.includes("\n")) {
    const lines = result.raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // verbose: OK\n<ip>\n...
    if (lines[0]?.toUpperCase() === "OK" && lines[1] && /^\d/.test(lines[1])) {
      result.ip = lines[1];
    }
  }
  return result;
}

/** Set TXT for DNS-01 (challenge value).*/
export async function setDuckDnsTxt(opts: {
  domain: string;
  token: string;
  txt: string;
}): Promise<DuckDnsUpdateResult> {
  const { subdomain } = normalizeDuckDnsDomain(opts.domain);
  const token = opts.token.trim();
  if (!token) throw new Error("DuckDNS token is empty");
  return duckDnsRequest({
    domains: subdomain,
    token,
    txt: opts.txt,
  });
}

/** Clear TXT after challenge.*/
export async function clearDuckDnsTxt(opts: {
  domain: string;
  token: string;
}): Promise<DuckDnsUpdateResult> {
  const { subdomain } = normalizeDuckDnsDomain(opts.domain);
  const token = opts.token.trim();
  if (!token) throw new Error("DuckDNS token is empty");
  return duckDnsRequest({
    domains: subdomain,
    token,
    txt: "",
    clear: "true",
  });
}
