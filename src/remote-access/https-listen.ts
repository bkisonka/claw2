// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * HTTPS reverse-proxy to public port → local gateway (127.0.0.1).
 * Terminates TLS with a certificate from LE DNS-01.
 */
import http from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Claw2Config } from "../config/types.js";
import { normalizeDuckDnsDomain } from "./duckdns.js";
import { readCertMeta } from "./acme-dns01.js";
import { writeRemoteAccessStatus } from "./status.js";
import { upnpMapTcp, upnpUnmapTcp } from "./upnp.js";

/**
 * Per-process secret proving a request passed through THIS process's HTTPS
 * proxy. The gateway requires it whenever X-Claw2-Via: remote-https is seen —
 * otherwise anything that can reach the plain HTTP listener directly could
 * spoof the via-header and ride the companion-auth path. Same process, so the
 * secret never crosses a network.
 */
const PROXY_SECRET = randomBytes(32).toString("hex");

export function getRemoteHttpsProxySecret(): string {
  return PROXY_SECRET;
}

let httpsServer: HttpsServer | null = null;
let listenPortActive: number | null = null;
let lastError: string | undefined;
/** Runtime override from tray: null = follow config; false = user closed. */
let manualOpen: boolean | null = null;
let upnpRenewTimer: ReturnType<typeof setInterval> | null = null;
let upnpMappedPort: number | null = null;

const UPNP_LEASE_SEC = 0; // many consumer routers only accept permanent leases (error 725)
const UPNP_RENEW_MS = 30 * 60 * 1000;

function clearUpnpRenew(): void {
  if (upnpRenewTimer) {
    clearInterval(upnpRenewTimer);
    upnpRenewTimer = null;
  }
}

async function applyUpnpMap(config: Claw2Config, port: number): Promise<void> {
  if (config.remoteAccess?.tls?.upnp === false) {
    writeRemoteAccessStatus({
      upnp: { enabled: false, lastError: undefined, mapped: false },
    });
    return;
  }
  const result = await upnpMapTcp({
    internalPort: port,
    externalPort: port,
    leaseSeconds: UPNP_LEASE_SEC,
  });
  if (result.ok) {
    upnpMappedPort = port;
    writeRemoteAccessStatus({
      upnp: {
        enabled: true,
        mapped: true,
        externalIp: result.externalIp,
        localIp: result.localIp,
        externalPort: result.externalPort,
        internalPort: result.internalPort,
        lastOkAt: Date.now(),
        lastError: undefined,
      },
    });
    console.error(
      `[remote-access] UPnP mapped TCP ${result.externalPort} → ${result.localIp}:${result.internalPort}` +
        (result.externalIp ? ` (WAN ${result.externalIp})` : "")
    );
    clearUpnpRenew();
    upnpRenewTimer = setInterval(() => {
      void upnpMapTcp({
        internalPort: port,
        externalPort: port,
        leaseSeconds: UPNP_LEASE_SEC,
      }).then((r) => {
        if (r.ok) {
          writeRemoteAccessStatus({
            upnp: {
              mapped: true,
              lastOkAt: Date.now(),
              externalIp: r.externalIp,
              localIp: r.localIp,
              lastError: undefined,
            },
          });
        } else {
          writeRemoteAccessStatus({
            upnp: { mapped: false, lastError: r.error, lastErrorAt: Date.now() },
          });
          console.error(`[remote-access] UPnP renew failed: ${r.error}`);
        }
      });
    }, UPNP_RENEW_MS);
    if (typeof upnpRenewTimer === "object" && upnpRenewTimer && "unref" in upnpRenewTimer) {
      upnpRenewTimer.unref();
    }
  } else {
    upnpMappedPort = null;
    writeRemoteAccessStatus({
      upnp: {
        enabled: true,
        mapped: false,
        localIp: result.localIp,
        lastError: result.error,
        lastErrorAt: Date.now(),
      },
    });
    console.error(`[remote-access] UPnP map failed: ${result.error}`);
  }
}

async function releaseUpnpMap(): Promise<void> {
  clearUpnpRenew();
  const port = upnpMappedPort;
  upnpMappedPort = null;
  if (port == null) {
    writeRemoteAccessStatus({ upnp: { mapped: false } });
    return;
  }
  const r = await upnpUnmapTcp({ externalPort: port });
  writeRemoteAccessStatus({
    upnp: {
      mapped: false,
      lastError: r.ok ? undefined : r.error,
      lastErrorAt: r.ok ? undefined : Date.now(),
    },
  });
  if (r.ok) console.error(`[remote-access] UPnP unmapped TCP ${port}`);
  else console.error(`[remote-access] UPnP unmap: ${r.error}`);
}

function localGatewayPort(config: Claw2Config): number {
  const p = config.gateway?.port;
  return typeof p === "number" && p > 0 ? p : 3000;
}

function resolveFqdn(config: Claw2Config): string | null {
  const domain = config.remoteAccess?.ddns?.domain?.trim();
  if (!domain) return null;
  try {
    return normalizeDuckDnsDomain(domain).fqdn;
  } catch {
    return null;
  }
}

export function isDdnsReady(config: Claw2Config): boolean {
  const d = config.remoteAccess?.ddns;
  return !!(d?.domain?.trim() && d?.token?.trim());
}

export function isHttpsListening(): boolean {
  return httpsServer != null && httpsServer.listening;
}

export function getHttpsListenInfo() {
  return {
    listening: isHttpsListening(),
    port: listenPortActive,
    lastError,
    manualOpen,
  };
}

function proxyRequest(config: Claw2Config, req: IncomingMessage, res: ServerResponse): void {
  const port = localGatewayPort(config);
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  headers["x-forwarded-proto"] = "https";
  headers["x-claw2-via"] = "remote-https";
  // Overwrite any client-supplied secret: only this proxy's value is valid.
  headers["x-claw2-proxy-secret"] = PROXY_SECRET;
  if (req.socket.remoteAddress) {
    headers["x-forwarded-for"] = req.socket.remoteAddress;
  }
  const preq = http.request(
    {
      hostname: "127.0.0.1",
      port,
      path: req.url,
      method: req.method,
      headers,
    },
    (pres) => {
      res.writeHead(pres.statusCode ?? 502, pres.headers);
      pres.pipe(res);
    }
  );
  preq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end(`Bad gateway: ${err.message}`);
  });
  req.pipe(preq);
}

export async function closeHttpsListen(): Promise<{ ok: boolean; error?: string }> {
  manualOpen = false;
  await releaseUpnpMap();
  if (!httpsServer) {
    listenPortActive = null;
    lastError = undefined;
    writeRemoteAccessStatus({
      https: { listening: false, lastError: undefined, closedAt: Date.now() },
    });
    return { ok: true };
  }
  const server = httpsServer;
  httpsServer = null;
  listenPortActive = null;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  writeRemoteAccessStatus({
    https: { listening: false, lastError: undefined, closedAt: Date.now() },
  });
  console.error("[remote-access] HTTPS listen closed");
  return { ok: true };
}

export async function openHttpsListen(
  config: Claw2Config,
  opts?: { force?: boolean }
): Promise<{ ok: boolean; port?: number; url?: string; error?: string }> {
  if (opts?.force) manualOpen = true;

  if (!isDdnsReady(config)) {
    lastError = "DDNS domain/token not configured";
    return { ok: false, error: lastError };
  }
  const fqdn = resolveFqdn(config);
  if (!fqdn) {
    lastError = "Invalid DuckDNS domain";
    return { ok: false, error: lastError };
  }
  const meta = readCertMeta(fqdn);
  if (!meta?.hasCert) {
    lastError = "Certificate missing — issue Let's Encrypt cert first";
    writeRemoteAccessStatus({
      https: { listening: false, lastError, lastErrorAt: Date.now() },
    });
    return { ok: false, error: lastError };
  }
  if (!existsSync(meta.fullchainPath) || !existsSync(meta.privkeyPath)) {
    lastError = "Certificate files not found on disk";
    return { ok: false, error: lastError };
  }

  const port = Math.max(1, Math.min(65535, config.remoteAccess?.tls?.listenPort ?? 443));

  if (isHttpsListening() && listenPortActive === port) {
    await applyUpnpMap(config, port);
    return { ok: true, port, url: `https://${fqdn}${port === 443 ? "" : `:${port}`}/` };
  }
  if (httpsServer) {
    const prev = httpsServer;
    httpsServer = null;
    await new Promise<void>((resolve) => prev.close(() => resolve()));
  }

  let key: Buffer;
  let cert: Buffer;
  try {
    key = readFileSync(meta.privkeyPath);
    cert = readFileSync(meta.fullchainPath);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    return { ok: false, error: lastError };
  }

  const server = createHttpsServer({ key, cert }, (req, res) => proxyRequest(config, req, res));

  try {
    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error) => {
        server.off("listening", onListen);
        reject(err);
      };
      const onListen = () => {
        server.off("error", onErr);
        resolve();
      };
      server.once("error", onErr);
      server.once("listening", onListen);
      server.listen(port, "0.0.0.0");
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const eacces =
      message.includes("EACCES") || message.includes("permission")
        ? `(port ${port} requires administrator rights; specify listenPort 8443 or run with rights)`
        : "";
    lastError = message + eacces;
    writeRemoteAccessStatus({
      https: { listening: false, port, lastError, lastErrorAt: Date.now() },
    });
    console.error(`[remote-access] HTTPS listen failed: ${lastError}`);
    return { ok: false, error: lastError };
  }

  httpsServer = server;
  listenPortActive = port;
  lastError = undefined;
  if (manualOpen === null) manualOpen = true;
  const url = `https://${fqdn}${port === 443 ? "" : `:${port}`}/`;
  writeRemoteAccessStatus({
    https: {
      listening: true,
      port,
      url,
      fqdn,
      openedAt: Date.now(),
      lastError: undefined,
    },
  });
  console.error(`[remote-access] HTTPS listening on 0.0.0.0:${port} → ${url}`);
  await applyUpnpMap(config, port);
  return { ok: true, port, url };
}

/**
 * Apply config: listenEnabled → open (if not closed manually from the tray).
 */
export async function syncHttpsListen(config: Claw2Config): Promise<void> {
  const tls = config.remoteAccess?.tls;
  const wantFeature = !!tls?.listenEnabled;
  if (!wantFeature) {
    manualOpen = null;
    if (isHttpsListening()) {
      // close without setting manualOpen false permanently as "user closed"
      if (httpsServer) {
        await releaseUpnpMap();
        const server = httpsServer;
        httpsServer = null;
        listenPortActive = null;
        await new Promise<void>((resolve) => server.close(() => resolve()));
        writeRemoteAccessStatus({
          https: { listening: false, closedAt: Date.now() },
        });
      }
    }
    return;
  }
  if (manualOpen === false) return;
  if (!isDdnsReady(config)) return;
  const r = await openHttpsListen(config);
  if (!r.ok) console.error(`[remote-access] sync HTTPS: ${r.error}`);
}

/** When minimized to tray: open the port if enabled and DDNS is ready.*/
export async function onTrayHideOpenHttps(config: Claw2Config): Promise<{
  ok: boolean;
  skipped?: boolean;
  error?: string;
  url?: string;
}> {
  const tls = config.remoteAccess?.tls;
  if (!tls?.listenEnabled) return { ok: true, skipped: true };
  // Deny by default: only open on tray-hide when explicitly enabled.
  if (!tls.openOnTrayHide) return { ok: true, skipped: true };
  if (!isDdnsReady(config)) return { ok: true, skipped: true };
  const r = await openHttpsListen(config, { force: true });
  return { ok: r.ok, error: r.error, url: r.url };
}
