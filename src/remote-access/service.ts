/**
 * Background DDNS, certificate LE DNS-01, HTTPS listen.
 */
import type { Claw2Config } from "../config/types.js";
import { issueLetsEncryptDns01, readCertMeta } from "./acme-dns01.js";
import { normalizeDuckDnsDomain, updateDuckDnsIp } from "./duckdns.js";
import {
  closeHttpsListen,
  getHttpsListenInfo,
  isDdnsReady,
  onTrayHideOpenHttps,
  openHttpsListen,
  syncHttpsListen,
} from "./https-listen.js";
import { readRemoteAccessStatus, writeRemoteAccessStatus } from "./status.js";

let ddnsTimer: ReturnType<typeof setInterval> | null = null;
let ddnsInFlight = false;
let certInFlight = false;
let getConfig: (() => Claw2Config) | null = null;

const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

export async function runDdnsUpdate(config: Claw2Config): Promise<{
  ok: boolean;
  fqdn?: string;
  ip?: string;
  error?: string;
}> {
  const ddns = config.remoteAccess?.ddns;
  if (!ddns?.domain?.trim() || !ddns?.token?.trim() || ddns.token.trim() === "***") {
    return { ok: false, error: "DuckDNS domain and token are required (save config first)" };
  }
  if (ddnsInFlight) {
    return { ok: false, error: "DDNS update already in progress" };
  }
  ddnsInFlight = true;
  try {
    const { fqdn } = normalizeDuckDnsDomain(ddns.domain);
    const result = await updateDuckDnsIp({
      domain: fqdn,
      token: ddns.token,
    });
    if (!result.ok) {
      writeRemoteAccessStatus({
        ddns: {
          lastErrorAt: Date.now(),
          lastError: result.raw || "DuckDNS update failed",
          fqdn,
        },
      });
      return { ok: false, fqdn, error: result.raw || "DuckDNS update failed" };
    }
    writeRemoteAccessStatus({
      ddns: {
        lastOkAt: Date.now(),
        lastError: undefined,
        lastErrorAt: undefined,
        lastIp: result.ip,
        fqdn,
      },
    });
    return { ok: true, fqdn, ip: result.ip };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeRemoteAccessStatus({
      ddns: {
        lastErrorAt: Date.now(),
        lastError: message,
      },
    });
    return { ok: false, error: message };
  } finally {
    ddnsInFlight = false;
  }
}

export async function runCertIssue(config: Claw2Config): Promise<{
  ok: boolean;
  fqdn?: string;
  fullchainPath?: string;
  privkeyPath?: string;
  expiresAt?: number;
  error?: string;
}> {
  const ddns = config.remoteAccess?.ddns;
  const tls = config.remoteAccess?.tls;
  if (!ddns?.domain?.trim() || !ddns?.token?.trim() || ddns.token.trim() === "***") {
    return { ok: false, error: "DuckDNS domain and token are required (save config first)" };
  }
  if (certInFlight) {
    return { ok: false, error: "Certificate request already in progress" };
  }
  certInFlight = true;
  try {
    const result = await issueLetsEncryptDns01({
      domain: ddns.domain,
      token: ddns.token,
      email: tls?.email,
      staging: !!tls?.staging,
      propagationMs: tls?.dnsPropagationMs,
    });
    // After cert: open port if listenEnabled
    if (config.remoteAccess?.tls?.listenEnabled) {
      void syncHttpsListen(config);
    }
    return {
      ok: true,
      fqdn: result.fqdn,
      fullchainPath: result.fullchainPath,
      privkeyPath: result.privkeyPath,
      expiresAt: result.expiresAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    certInFlight = false;
  }
}

export function getRemoteAccessPublicStatus(config: Claw2Config) {
  const ra = config.remoteAccess;
  const ddns = ra?.ddns;
  const tls = ra?.tls;
  const file = readRemoteAccessStatus();
  let fqdn: string | undefined;
  try {
    if (ddns?.domain?.trim()) fqdn = normalizeDuckDnsDomain(ddns.domain).fqdn;
  } catch {
    fqdn = undefined;
  }
  const certMeta = fqdn ? readCertMeta(fqdn) : null;
  const httpsInfo = getHttpsListenInfo();
  const listenPort = tls?.listenPort ?? 443;
  return {
    provider: "duckdns" as const,
    ddnsEnabled: !!ddns?.enabled,
    tlsEnabled: !!tls?.enabled,
    listenEnabled: !!tls?.listenEnabled,
    openOnTrayHide: !!tls?.openOnTrayHide,
    listenPort,
    domainConfigured: isDdnsReady(config),
    fqdn: fqdn ?? file.ddns?.fqdn ?? file.cert?.fqdn,
    staging: !!tls?.staging,
    ddns: file.ddns ?? {},
    cert: {
      ...(file.cert ?? {}),
      hasCert: !!certMeta?.hasCert,
      fullchainPath: certMeta?.fullchainPath,
      privkeyPath: certMeta?.privkeyPath,
      expiresAt: certMeta?.expiresAt ?? file.cert?.expiresAt,
    },
    https: {
      ...(file.https ?? {}),
      listening: httpsInfo.listening,
      port: httpsInfo.port ?? file.https?.port,
      lastError: httpsInfo.lastError ?? file.https?.lastError,
      url:
        httpsInfo.listening && fqdn
          ? `https://${fqdn}${listenPort === 443 ? "" : `:${listenPort}`}/`
          : file.https?.url,
    },
    upnp: {
      enabled: tls?.upnp !== false,
      ...(file.upnp ?? {}),
    },
    busy: { ddns: ddnsInFlight, cert: certInFlight },
  };
}

export async function runHttpsOpen(config: Claw2Config) {
  return openHttpsListen(config, { force: true });
}

export async function runHttpsClose() {
  return closeHttpsListen();
}

export async function runHttpsOnTrayHide(config: Claw2Config) {
  return onTrayHideOpenHttps(config);
}

async function maybeAutoRenewCert(config: Claw2Config): Promise<void> {
  const tls = config.remoteAccess?.tls;
  if (!tls?.enabled) return;
  const st = getRemoteAccessPublicStatus(config);
  if (!st.cert.hasCert || !st.cert.expiresAt) return;
  if (st.cert.expiresAt - Date.now() > RENEW_BEFORE_MS) return;
  console.error("[remote-access] Certificate nearing expiry — renewing via DNS-01");
  const r = await runCertIssue(config);
  if (r.ok) console.error(`[remote-access] Cert renewed for ${r.fqdn}`);
  else console.error(`[remote-access] Cert renew failed: ${r.error}`);
}

/** Start/restart background DDNS + HTTPS. pass() => configRef.current.*/
export function syncRemoteAccess(configRef: () => Claw2Config): void {
  getConfig = configRef;
  if (ddnsTimer) {
    clearInterval(ddnsTimer);
    ddnsTimer = null;
  }
  const config = configRef();
  const ddns = config.remoteAccess?.ddns;

  void syncHttpsListen(config).catch((err) =>
    console.error("[remote-access] HTTPS sync:", err instanceof Error ? err.message : err)
  );

  if (!ddns?.enabled) {
    console.error("[remote-access] DDNS disabled");
    return;
  }
  if (!ddns.domain?.trim() || !ddns.token?.trim()) {
    console.error("[remote-access] DDNS enabled but domain/token missing");
    return;
  }
  const minutes = Math.max(5, ddns.updateIntervalMinutes ?? 30);
  const ms = minutes * 60_000;
  console.error(`[remote-access] DuckDNS enabled, interval ${minutes}m`);

  const tick = async () => {
    const cfg = getConfig?.() ?? config;
    const r = await runDdnsUpdate(cfg);
    if (r.ok) console.error(`[remote-access] DDNS ok ${r.fqdn}${r.ip ? ` → ${r.ip}` : ""}`);
    else console.error(`[remote-access] DDNS error: ${r.error}`);
    await maybeAutoRenewCert(cfg);
  };

  void tick();
  ddnsTimer = setInterval(() => {
    void tick();
  }, ms);
  if (typeof ddnsTimer === "object" && ddnsTimer && "unref" in ddnsTimer) {
    ddnsTimer.unref();
  }
}
