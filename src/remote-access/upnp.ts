// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Minimal UPnP IGD (Internet Gateway Device) client — no deps.
 * Discovers the LAN router via SSDP and AddPortMapping / DeletePortMapping.
 * Requires UPnP enabled on the router (user choice for PWA behind NAT).
 */
import dgram from "node:dgram";
import http from "node:http";
import { networkInterfaces } from "node:os";

const SSDP_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;
const DEFAULT_LEASE_SEC = 3600;
const DESCRIPTION = "claw2-https";

export type UpnpMapResult = {
  ok: boolean;
  externalIp?: string;
  localIp?: string;
  externalPort?: number;
  internalPort?: number;
  error?: string;
};

type Gateway = {
  location: string;
  controlUrl: string;
  serviceType: string;
};

function httpGet(url: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`timeout fetching ${url}`));
    });
  });
}

class UpnpSoapError extends Error {
  constructor(
    readonly action: string,
    readonly code: number | undefined,
    readonly description: string | undefined,
    readonly httpStatus?: number
  ) {
    const bits = [`UPnP ${action}`];
    if (code != null) bits.push(`error ${code}`);
    if (description) bits.push(description);
    else if (httpStatus) bits.push(`HTTP ${httpStatus}`);
    super(bits.join(": "));
    this.name = "UpnpSoapError";
  }
}

function parseUpnpFault(text: string): { code?: number; description?: string } {
  const codeRaw = text.match(/<errorCode>\s*(\d+)\s*<\/errorCode>/i)?.[1];
  const description = text.match(/<errorDescription>\s*([^<]*)\s*<\/errorDescription>/i)?.[1]?.trim();
  return {
    code: codeRaw ? Number(codeRaw) : undefined,
    description: description || undefined,
  };
}

function soapRequest(
  controlUrl: string,
  serviceType: string,
  action: string,
  bodyInner: string,
  timeoutMs = 8000
): Promise<string> {
  const envelope =
    `<?xml version="1.0"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body>` +
    `<u:${action} xmlns:u="${serviceType}">${bodyInner}</u:${action}>` +
    `</s:Body></s:Envelope>`;

  return new Promise((resolve, reject) => {
    const u = new URL(controlUrl);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": 'text/xml; charset="utf-8"',
          SOAPAction: `"${serviceType}#${action}"`,
          "Content-Length": Buffer.byteLength(envelope),
          Connection: "close",
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const fault = /UPnPError|faultstring|errorCode/i.test(text);
          if (fault || (res.statusCode ?? 0) >= 400) {
            const { code, description } = parseUpnpFault(text);
            reject(new UpnpSoapError(action, code, description, res.statusCode));
            return;
          }
          resolve(text);
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`UPnP ${action} timeout`));
    });
    req.write(envelope);
    req.end();
  });
}

function xmlLocal(tag: string, xml: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i");
  return xml.match(re)?.[1]?.trim();
}

function resolveUrl(base: string, maybeRelative: string): string {
  try {
    return new URL(maybeRelative, base).href;
  } catch {
    return maybeRelative;
  }
}

/** Prefer private IPv4 used for default route (UDP connect trick). */
export function guessLanIPv4(): string | undefined {
  const nets = networkInterfaces();
  for (const list of Object.values(nets)) {
    if (!list) continue;
    for (const n of list) {
      const fam = String(n.family);
      if ((fam === "IPv4" || fam === "4") && !n.internal) return n.address;
    }
  }
  return undefined;
}

/** Async: UDP connect reveals the outbound interface address. */
export function detectLanIPv4(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const fallback = guessLanIPv4();
    try {
      const sock = dgram.createSocket("udp4");
      const finish = (ip?: string) => {
        try {
          sock.close();
        } catch {
          /* ignore */
        }
        resolve(ip || fallback);
      };
      sock.once("error", () => finish(fallback));
      sock.connect(53, "8.8.8.8", () => {
        try {
          const addr = sock.address();
          if (typeof addr === "object" && addr.address && !addr.address.startsWith("127.")) {
            finish(addr.address);
          } else {
            finish(fallback);
          }
        } catch {
          finish(fallback);
        }
      });
    } catch {
      resolve(fallback);
    }
  });
}

function ssdpSearch(timeoutMs = 3500): Promise<string[]> {
  const stCandidates = [
    "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
    "urn:schemas-upnp-org:device:InternetGatewayDevice:2",
    "urn:schemas-upnp-org:service:WANIPConnection:1",
    "urn:schemas-upnp-org:service:WANIPConnection:2",
    "upnp:rootdevice",
  ];
  return new Promise((resolve) => {
    const locations = new Set<string>();
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const done = () => {
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      resolve([...locations]);
    };
    const timer = setTimeout(done, timeoutMs);
    sock.on("message", (msg) => {
      const text = msg.toString("utf8");
      const loc = text.match(/LOCATION:\s*(\S+)/i)?.[1]?.trim();
      if (loc) locations.add(loc);
    });
    sock.on("error", () => {
      clearTimeout(timer);
      done();
    });
    sock.bind(() => {
      try {
        sock.setBroadcast(true);
      } catch {
        /* ignore */
      }
      for (const st of stCandidates) {
        const payload =
          `M-SEARCH * HTTP/1.1\r\n` +
          `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
          `MAN: "ssdp:discover"\r\n` +
          `MX: 2\r\n` +
          `ST: ${st}\r\n` +
          `\r\n`;
        sock.send(payload, SSDP_PORT, SSDP_ADDR);
      }
    });
  });
}

function pickWanService(descXml: string, location: string): Gateway | null {
  const serviceTypes = [
    "urn:schemas-upnp-org:service:WANIPConnection:2",
    "urn:schemas-upnp-org:service:WANIPConnection:1",
    "urn:schemas-upnp-org:service:WANPPPConnection:1",
  ];
  for (const serviceType of serviceTypes) {
    // Find <service>… block containing this serviceType
    const re = new RegExp(
      `<service>[\\s\\S]*?<serviceType>\\s*${serviceType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*</serviceType>[\\s\\S]*?</service>`,
      "i"
    );
    const block = descXml.match(re)?.[0];
    if (!block) continue;
    const control = xmlLocal("controlURL", block);
    if (!control) continue;
    return {
      location,
      controlUrl: resolveUrl(location, control),
      serviceType,
    };
  }
  return null;
}

async function discoverGateway(): Promise<Gateway> {
  const locations = await ssdpSearch();
  if (!locations.length) {
    throw new Error("UPnP: no gateway found (enable UPnP/IGD on the router)");
  }
  const errors: string[] = [];
  for (const location of locations) {
    try {
      const xml = await httpGet(location);
      const gw = pickWanService(xml, location);
      if (gw) return gw;
      errors.push(`${location}: no WANIPConnection service`);
    } catch (e) {
      errors.push(`${location}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`UPnP: no usable IGD (${errors.slice(0, 3).join("; ")})`);
}

async function getExternalIp(gw: Gateway): Promise<string | undefined> {
  try {
    const xml = await soapRequest(gw.controlUrl, gw.serviceType, "GetExternalIPAddress", "");
    return xmlLocal("NewExternalIPAddress", xml);
  } catch {
    return undefined;
  }
}

async function getSpecificMapping(
  gw: Gateway,
  externalPort: number
): Promise<{ internalClient?: string; internalPort?: number } | null> {
  try {
    const xml = await soapRequest(
      gw.controlUrl,
      gw.serviceType,
      "GetSpecificPortMappingEntry",
      `<NewRemoteHost></NewRemoteHost>` +
        `<NewExternalPort>${externalPort}</NewExternalPort>` +
        `<NewProtocol>TCP</NewProtocol>`
    );
    return {
      internalClient: xmlLocal("NewInternalClient", xml),
      internalPort: Number(xmlLocal("NewInternalPort", xml) || 0) || undefined,
    };
  } catch {
    return null;
  }
}

function addPortMappingBody(opts: {
  externalPort: number;
  internalPort: number;
  localIp: string;
  leaseSeconds: number;
}): string {
  return (
    `<NewRemoteHost></NewRemoteHost>` +
    `<NewExternalPort>${opts.externalPort}</NewExternalPort>` +
    `<NewProtocol>TCP</NewProtocol>` +
    `<NewInternalPort>${opts.internalPort}</NewInternalPort>` +
    `<NewInternalClient>${opts.localIp}</NewInternalClient>` +
    `<NewEnabled>1</NewEnabled>` +
    `<NewPortMappingDescription>${DESCRIPTION}</NewPortMappingDescription>` +
    `<NewLeaseDuration>${opts.leaseSeconds}</NewLeaseDuration>`
  );
}

function explainUpnpCode(code: number | undefined, port: number): string {
  switch (code) {
    case 718:
      return port === 443
        ? "port 443 conflict — often reserved by the router’s own HTTPS/admin; use listenPort 8443"
        : `port ${port} already mapped — Close HTTPS and retry, free it in the router, or pick another listenPort`;
    case 724:
      return "router requires same external/internal port";
    case 725:
      return "router only allows permanent leases";
    case 501:
      return port < 1024
        ? `router rejected privileged port ${port} — try listenPort 8443`
        : "router rejected the mapping (Action Failed)";
    default:
      return code != null ? `see router UPnP error ${code}` : "check UPnP is enabled on the router";
  }
}

async function tryAddPortMapping(
  gw: Gateway,
  opts: { externalPort: number; internalPort: number; localIp: string; leaseSeconds: number }
): Promise<void> {
  await soapRequest(
    gw.controlUrl,
    gw.serviceType,
    "AddPortMapping",
    addPortMappingBody(opts)
  );
}

export async function upnpMapTcp(opts: {
  internalPort: number;
  externalPort?: number;
  leaseSeconds?: number;
  localIp?: string;
}): Promise<UpnpMapResult> {
  const externalPort = opts.externalPort ?? opts.internalPort;
  const preferredLease = opts.leaseSeconds ?? DEFAULT_LEASE_SEC;
  const localIp = opts.localIp ?? (await detectLanIPv4());
  if (!localIp) {
    return { ok: false, error: "UPnP: cannot detect LAN IPv4" };
  }
  try {
    const gw = await discoverGateway();

    // Already mapped to this PC → success (avoids false 718 after our own Open HTTPS / tests)
    const existing = await getSpecificMapping(gw, externalPort);
    if (
      existing?.internalClient === localIp &&
      (existing.internalPort == null || existing.internalPort === opts.internalPort)
    ) {
      const externalIp = await getExternalIp(gw);
      return {
        ok: true,
        externalIp,
        localIp,
        externalPort,
        internalPort: opts.internalPort,
      };
    }

    const deleteStale = async () => {
      try {
        await soapRequest(
          gw.controlUrl,
          gw.serviceType,
          "DeletePortMapping",
          `<NewRemoteHost></NewRemoteHost>` +
            `<NewExternalPort>${externalPort}</NewExternalPort>` +
            `<NewProtocol>TCP</NewProtocol>`
        );
      } catch {
        /* no existing mapping */
      }
    };

    await deleteStale();

    const leasesToTry = [...new Set([preferredLease, 0])].filter((n) => n >= 0);

    let lastErr: unknown;
    for (const leaseSeconds of leasesToTry) {
      try {
        await tryAddPortMapping(gw, {
          externalPort,
          internalPort: opts.internalPort,
          localIp,
          leaseSeconds,
        });
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
        const code = e instanceof UpnpSoapError ? e.code : undefined;
        if (code === 718) {
          await deleteStale();
          const again = await getSpecificMapping(gw, externalPort);
          if (again?.internalClient === localIp) {
            lastErr = undefined;
            break;
          }
          try {
            await tryAddPortMapping(gw, {
              externalPort,
              internalPort: opts.internalPort,
              localIp,
              leaseSeconds: 0,
            });
            lastErr = undefined;
            break;
          } catch (e2) {
            lastErr = e2;
          }
        }
      }
    }

    if (lastErr) {
      const code = lastErr instanceof UpnpSoapError ? lastErr.code : undefined;
      const base = lastErr instanceof Error ? lastErr.message : String(lastErr);
      throw new Error(`${base} (${explainUpnpCode(code, externalPort)})`);
    }

    const externalIp = await getExternalIp(gw);
    return {
      ok: true,
      externalIp,
      localIp,
      externalPort,
      internalPort: opts.internalPort,
    };
  } catch (e) {
    return {
      ok: false,
      localIp,
      externalPort,
      internalPort: opts.internalPort,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function upnpUnmapTcp(opts: {
  externalPort: number;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const gw = await discoverGateway();
    await soapRequest(
      gw.controlUrl,
      gw.serviceType,
      "DeletePortMapping",
      `<NewRemoteHost></NewRemoteHost>` +
        `<NewExternalPort>${opts.externalPort}</NewExternalPort>` +
        `<NewProtocol>TCP</NewProtocol>`
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
