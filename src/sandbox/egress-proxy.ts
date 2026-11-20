/**
 * Egress guard proxy for skills (sandbox.egress.mode: "guard", the default):
 * an HTTP/CONNECT proxy in front of the same SSRF rules as web_fetch
 * (security/url-guard.ts). Skills are pointed at it via the egress preload
 * (NODE_OPTIONS --require), so their fetch/http/https cannot reach loopback,
 * private, link-local or metadata addresses — attempts are audited.
 *
 * Blocking happens on a resolved IP: the target hostname is resolved, every
 * address must pass isPublicAddress, and the socket connects to that literal
 * IP (SNI/Host preserved) — no rebind window between check and connect.
 *
 * Listeners are per-host: 127.0.0.1 for host/in-container skills, plus the
 * docker network gateway IP when skills run in the Docker sandbox (--internal
 * network; the only host-reachable point from an isolated network).
 */
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { lookup } from "node:dns/promises";
import { isPublicAddress } from "../security/url-guard.js";
import { auditLog } from "../audit/log.js";
import type { Claw2Config } from "../config/types.js";

const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 180_000;

export interface EgressGuardOptions {
  /** Gateway config for audit logging; omit in the standalone sidecar (blocks are logged to stderr). */
  config?: Claw2Config;
  /** Mirror of tools.webFetch.allowPrivateHosts for self-hosters with LAN services. */
  allowPrivateHosts?: boolean;
  /** Sidecar mode: audit hook override (gateway wires auditLog, sidecar logs to stderr). */
  onBlocked?: (details: { host: string; port: string; reason: string }) => void;
}

export interface EgressGuardProxy {
  /**
   * Ensure a listener on `host`; resolves with its port. `port` is used as
   * given (the sidecar binds the fixed 3128), 0 picks a free port.
   */
  listenOn(host: string, port?: number): Promise<number>;
  close(): Promise<void>;
}

interface GuardedTarget {
  ip: string;
  port: number;
  servername?: string;
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
 * Resolve `host` and return a literal IP that is safe to connect to, or a
 * denial reason. Denials are audited by the caller.
 */
async function guardAndResolve(
  host: string,
  opts: EgressGuardOptions
): Promise<{ ok: true; target: GuardedTarget } | { ok: false; error: string }> {
  if (opts.allowPrivateHosts) {
    // Explicit opt-out: connect by name like a normal proxy would.
    return { ok: true, target: { ip: host, port: 0, servername: undefined } };
  }
  const h = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (hostnameIsInternal(h)) return { ok: false, error: `internal host (${h})` };
  if (isIP(h) !== 0) {
    return isPublicAddress(h)
      ? { ok: true, target: { ip: h, port: 0 } }
      : { ok: false, error: `private or internal address (${h})` };
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(h, { all: true });
  } catch {
    return { ok: false, error: `dns lookup failed for ${h}` };
  }
  const publicAddrs = addrs.filter((a) => isPublicAddress(a.address.toLowerCase()));
  if (publicAddrs.length === 0) {
    return { ok: false, error: `${h} resolves to private/internal only` };
  }
  // Connect to a checked literal — no DNS-rebind window.
  return { ok: true, target: { ip: publicAddrs[0].address, port: 0, servername: h } };
}

export function createEgressGuardProxy(opts: EgressGuardOptions): EgressGuardProxy {
  const listeners = new Map<string, { server: Server; port: number }>();

  function auditBlocked(host: string, port: string, reason: string): void {
    if (opts.onBlocked) {
      opts.onBlocked({ host, port, reason });
      return;
    }
    if (!opts.config) return;
    auditLog(opts.config, {
      type: "egress_blocked",
      details: { host, port, reason, allowPrivateHosts: !!opts.allowPrivateHosts },
    });
  }

  function destroyBoth(a: Socket, b: Socket): void {
    a.destroy();
    b.destroy();
  }

  async function handleConnect(
    req: IncomingMessage,
    clientSocket: Socket,
    head: Buffer
  ): Promise<void> {
    const authority = req.url ?? "";
    const m = authority.match(/^([^:]+):(\d+)$/);
    if (!m) {
      clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    const host = m[1];
    const port = Number(m[2]);
    const g = await guardAndResolve(host, opts);
    if (!g.ok) {
      auditBlocked(host, String(port), g.error);
      clientSocket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    const target = netConnect({ host: g.target.ip, port });
    const connectTimeout = () => {
      clientSocket.write("HTTP/1.1 504 Gateway Timeout\r\n\r\n");
      clientSocket.destroy();
      target.destroy();
    };
    target.setTimeout(CONNECT_TIMEOUT_MS);
    target.once("timeout", connectTimeout);
    target.once("error", () => {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.destroy();
    });
    target.once("connect", () => {
      target.setTimeout(IDLE_TIMEOUT_MS);
      target.removeListener("timeout", connectTimeout);
      const idle = () => destroyBoth(clientSocket, target);
      target.once("timeout", idle);
      clientSocket.setTimeout(IDLE_TIMEOUT_MS);
      clientSocket.once("timeout", idle);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) target.write(head);
      clientSocket.pipe(target);
      target.pipe(clientSocket);
      const cleanup = () => destroyBoth(clientSocket, target);
      clientSocket.once("error", cleanup);
      target.once("error", cleanup);
      clientSocket.once("close", cleanup);
      target.once("close", cleanup);
      clientSocket.setTimeout(IDLE_TIMEOUT_MS);
      clientSocket.once("timeout", cleanup);
      target.once("timeout", cleanup);
    });
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Origin-form (GET /path): only the sidecar health endpoint is served.
    if (!req.url?.startsWith("http://") && !req.url?.startsWith("https://")) {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("egress guard: absolute-URI proxy requests only");
      return;
    }
    // Absolute-URI form (plain http through a proxy): url is the full target.
    let u: URL;
    try {
      u = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (u.protocol !== "http:") {
      res.writeHead(403).end();
      return;
    }
    const port = u.port ? Number(u.port) : 80;
    void guardAndResolve(u.hostname, opts).then((g) => {
      if (!g.ok) {
        auditBlocked(u.hostname, String(port), g.error);
        res.writeHead(403, { "content-type": "text/plain" });
        res.end(`blocked by egress guard: ${g.error}`);
        return;
      }
      const headers = { ...req.headers, host: u.host };
      const out = httpRequest(
        { host: g.target.ip, port, path: `${u.pathname}${u.search}`, method: req.method, headers },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        }
      );
      out.setTimeout(CONNECT_TIMEOUT_MS, () => {
        out.destroy(new Error("connect timeout"));
      });
      out.on("error", () => {
        try {
          res.writeHead(502).end();
        } catch {
          /* headers already sent */
        }
      });
      req.pipe(out);
    });
  }

  function makeServer(): Server {
    const server = createServer((req, res) => handleRequest(req, res));
    server.on("connect", (req, socket, head) => {
      void handleConnect(req, socket as Socket, head);
    });
    server.on("clientError", (_err, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
    return server;
  }

  return {
    listenOn(host: string, wantPort: number = 0): Promise<number> {
      const existing = listeners.get(host);
      if (existing) return Promise.resolve(existing.port);
      return new Promise((resolvePromise, rejectPromise) => {
        const server = makeServer();
        server.once("error", rejectPromise);
        server.listen(wantPort, host, () => {
          const addr = server.address();
          const port = typeof addr === "object" && addr ? addr.port : 0;
          listeners.set(host, { server, port });
          resolvePromise(port);
        });
      });
    },
    async close(): Promise<void> {
      const all = [...listeners.values()];
      listeners.clear();
      await Promise.all(
        all.map(
          ({ server }) =>
            new Promise<void>((res) => {
              server.close(() => res());
            })
        )
      );
    },
  };
}

let singleton: EgressGuardProxy | null = null;
let singletonKey = "";

/**
 * Process-wide guard proxy (one per gateway). The allowPrivateHosts flag is
 * fixed for the lifetime of the process — changing it requires a restart,
 * same as the config reload semantics for the gateway itself.
 */
export function getEgressGuardProxy(opts: EgressGuardOptions): EgressGuardProxy {
  const key = opts.allowPrivateHosts ? "private" : "strict";
  if (!singleton || singletonKey !== key) {
    singleton?.close().catch(() => undefined);
    singleton = createEgressGuardProxy(opts);
    singletonKey = key;
  }
  return singleton;
}

/** Test hook: drop the singleton so tests can start fresh. */
export function resetEgressGuardProxyForTest(): void {
  singleton?.close().catch(() => undefined);
  singleton = null;
  singletonKey = "";
}
