// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Docker API guard proxy (replaces the generic docker-socket-proxy).
 *
 * The gateway talks to the host docker through DOCKER_HOST=tcp://docker-guard.
 * A generic endpoint-filtering proxy (tecnativa) cannot constrain what a
 * compromised gateway may ASK FOR: `CONTAINERS=1 + POST=1` admits
 * POST /containers/create with a privileged, host-mounting container config —
 * which is host compromise on a rootful daemon. The endpoint filter checks
 * routes, not request bodies.
 *
 * This guard does both:
 *   1. An explicit allowlist of the exact endpoints the skill sandbox uses
 *      (container/network lifecycle, image pull, ping) — everything else 403s.
 *   2. A structural validation of every POST /containers/create body: the
 *      hardening profile is mandatory (cap-drop ALL, no-new-privileges,
 *      read-only rootfs), privilege widening is rejected (privileged, cap-add,
 *      devices, host namespaces, published ports), and bind sources must sit
 *      inside the operator-declared sandbox roots (CLAW2_DOCKER_GUARD_ALLOWED_
 *      BIND_SRC) with container targets under /app (or the sidecar script).
 *
 * Runs in its own container with read-only access to docker.sock and no other
 * capabilities; it never talks to the application database or the network
 * beyond the internal control network.
 */
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

const DOCKER_METHODS = new Set(["GET", "POST", "DELETE", "HEAD"]);

/** {id} segments accept docker names/ids (hex, uuid, name, name.uuid). */
const SEG = "[A-Za-z0-9][A-Za-z0-9_.-]*";

/**
 * Endpoints the claw2 skill sandbox legitimately uses via the docker CLI
 * (docker version/run/rm/kill/logs/network inspect/create, container
 * inspect/start/wait/attach). Anything else — exec, build, volume, swarm,
 * secrets, auth, image push/save — is outside the sandbox contract.
 */
const ALLOWED_ENDPOINTS: { method: string; re: RegExp }[] = [
  { method: "GET", re: /^\/_ping$/ },
  { method: "GET", re: /^\/version$/ },
  { method: "GET", re: new RegExp(`^\\/images\\/${SEG}\\/json$`) },
  { method: "POST", re: /^\/images\/create$/ },
  { method: "POST", re: /^\/containers\/create$/ },
  { method: "GET", re: new RegExp(`^\\/containers\\/${SEG}\\/json$`) },
  { method: "GET", re: new RegExp(`^\\/containers\\/${SEG}\\/logs$`) },
  { method: "POST", re: new RegExp(`^\\/containers\\/${SEG}\\/(start|wait|kill|attach)$`) },
  { method: "DELETE", re: new RegExp(`^\\/containers\\/${SEG}$`) },
  { method: "GET", re: /^\/networks$/ },
  { method: "GET", re: new RegExp(`^\\/networks\\/${SEG}$`) },
  { method: "POST", re: /^\/networks\/create$/ },
  { method: "POST", re: new RegExp(`^\\/networks\\/${SEG}\\/(connect|disconnect)$`) },
  { method: "DELETE", re: new RegExp(`^\\/networks\\/${SEG}$`) },
];

/** Strip the docker API version prefix (/v1.47/containers/... → /containers/...). */
function normalizePath(pathWithQuery: string): string {
  const path = pathWithQuery.split("?")[0] ?? "";
  return path.replace(/^\/v1\.\d+\//, "/");
}

export function isAllowedDockerEndpoint(method: string, pathWithQuery: string): boolean {
  if (!DOCKER_METHODS.has(method)) return false;
  const path = normalizePath(pathWithQuery);
  return ALLOWED_ENDPOINTS.some((e) => e.method === method && e.re.test(path));
}

export interface ContainerCreateCheck {
  ok: boolean;
  error?: string;
}

function isNonEmptyArray(v: unknown): v is unknown[] {
  return Array.isArray(v) && v.length > 0;
}

/** Validate one bind spec ("src:dst[:opts]") against the sandbox roots. */
function checkBind(
  bind: string,
  allowedSrcPrefixes: string[]
): string | null {
  const parts = bind.split(":");
  if (parts.length < 2) return `malformed bind "${bind}"`;
  const src = (parts[0] ?? "").trim();
  const dst = (parts[1] ?? "").trim();
  const opts = parts.slice(2).join(":");
  if (!src.startsWith("/")) return `bind source must be absolute: "${bind}"`;
  if (src.includes("..")) return `bind source must not contain "..": "${bind}"`;
  if (!dst.startsWith("/app/") && dst !== "/sidecar.cjs") {
    return `bind target must be /app/** or /sidecar.cjs: "${bind}"`;
  }
  const ro = opts === "" || opts.split(",").includes("ro");
  if (!ro) return `binds must be read-only or the sandbox output mount: "${bind}"`;
  if (
    !allowedSrcPrefixes.some((p) => {
      const root = p.endsWith("/") ? p : p + "/";
      return (src + "/").startsWith(root);
    })
  ) {
    return `bind source "${src}" is outside the allowed sandbox roots`;
  }
  return null;
}

/**
 * Structural validation of a POST /containers/create body.
 * `allowedSrcPrefixes` come from CLAW2_DOCKER_GUARD_ALLOWED_BIND_SRC
 * (colon-separated host path roots); empty list = no binds allowed at all.
 */
export function validateContainerCreateBody(
  body: unknown,
  allowedSrcPrefixes: string[]
): ContainerCreateCheck {
  if (!body || typeof body !== "object") return { ok: false, error: "container create body required" };
  const b = body as Record<string, unknown>;
  const hc = (b.HostConfig ?? {}) as Record<string, unknown>;

  // Mandatory hardening profile (both gateway-created containers set these).
  const capDrop = Array.isArray(hc.CapDrop) ? (hc.CapDrop as string[]).map((s) => String(s).toUpperCase()) : [];
  if (!capDrop.includes("ALL")) return { ok: false, error: "CapDrop=[ALL] is required" };
  const secOpt = Array.isArray(hc.SecurityOpt) ? (hc.SecurityOpt as string[]).map((s) => String(s).toLowerCase()) : [];
  if (!secOpt.some((s) => s.includes("no-new-privileges"))) {
    return { ok: false, error: "SecurityOpt no-new-privileges is required" };
  }
  if (hc.ReadonlyRootfs !== true) return { ok: false, error: "ReadonlyRootfs is required" };

  // Privilege widening is rejected outright.
  if (hc.Privileged === true) return { ok: false, error: "privileged containers are not allowed" };
  if (isNonEmptyArray(hc.CapAdd)) return { ok: false, error: "CapAdd is not allowed" };
  if (isNonEmptyArray(hc.Devices) || isNonEmptyArray(b.Devices)) return { ok: false, error: "devices are not allowed" };
  for (const key of ["PidnsMode", "IpcMode", "UsernsMode", "NetworkMode"]) {
    const v = hc[key];
    if (typeof v === "string" && (v === "host" || v.startsWith("ns:"))) {
      return { ok: false, error: `${key}=host is not allowed` };
    }
  }
  if (hc.AutoRemove === true && hc.RestartPolicy && (hc.RestartPolicy as Record<string, unknown>).Name) {
    return { ok: false, error: "restart policy is not allowed" };
  }
  // PortBindings/ExposedPorts are objects keyed by "port/proto", not arrays.
  const portBindings = hc.PortBindings;
  if (portBindings && typeof portBindings === "object" && Object.keys(portBindings).length > 0) {
    return { ok: false, error: "published ports are not allowed" };
  }
  if (b.ExposedPorts && typeof b.ExposedPorts === "object" && Object.keys(b.ExposedPorts).length > 0) {
    return { ok: false, error: "published ports are not allowed" };
  }
  if (isNonEmptyArray(hc.Mounts)) return { ok: false, error: "volume mounts are not allowed (binds only)" };
  const sysctls = hc.Sysctls;
  if (sysctls && typeof sysctls === "object" && Object.keys(sysctls).length > 0) {
    return { ok: false, error: "sysctls are not allowed" };
  }

  // Binds: source inside the declared sandbox roots, target under /app.
  const binds = Array.isArray(hc.Binds) ? (hc.Binds as string[]) : [];
  for (const bind of binds) {
    const err = checkBind(String(bind), allowedSrcPrefixes);
    if (err) return { ok: false, error: err };
  }
  return { ok: true };
}

const MAX_CREATE_BODY_BYTES = 256 * 1024;

function jsonError(res: ServerResponse, status: number, message: string): void {
  const payload = JSON.stringify({ message });
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

export interface DockerGuardServerOptions {
  socketPath?: string;
  allowedBindSrc?: string[];
  /** Guard-side rejection hook (audit/console). */
  onReject?: (detail: string) => void;
}

export function createDockerGuardServer(opts: DockerGuardServerOptions = {}): http.Server {
  const socketPath = opts.socketPath ?? "/var/run/docker.sock";
  const allowedBindSrc = (opts.allowedBindSrc ?? [])
    .map((p) => p.trim())
    .filter(Boolean);

  const forward = (
    req: IncomingMessage,
    res: ServerResponse,
    targetPath: string
  ): void => {
    const preq = http.request(
      {
        socketPath,
        path: targetPath,
        method: req.method,
        headers: { ...req.headers, host: "docker" },
      },
      (pres) => {
        res.writeHead(pres.statusCode ?? 502, pres.headers);
        pres.pipe(res);
      }
    );
    preq.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ message: `docker guard upstream error: ${err.message}` }));
    });
    req.pipe(preq);
  };

  return http.createServer((req, res) => {
    const method = (req.method ?? "GET").toUpperCase();
    const rawUrl = req.url ?? "/";
    const path = normalizePath(rawUrl);

    if (!isAllowedDockerEndpoint(method, rawUrl)) {
      opts.onReject?.(`endpoint ${method} ${path}`);
      jsonError(res, 403, "docker guard: endpoint not allowed");
      return;
    }

    if (method === "POST" && path === "/containers/create") {
      const chunks: Buffer[] = [];
      let total = 0;
      let aborted = false;
      req.on("data", (c: Buffer) => {
        if (aborted) return;
        total += c.length;
        if (total > MAX_CREATE_BODY_BYTES) {
          aborted = true;
          req.destroy();
          opts.onReject?.("containers/create body too large");
          jsonError(res, 413, "docker guard: body too large");
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (aborted) return;
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        } catch {
          opts.onReject?.("containers/create invalid JSON");
          jsonError(res, 400, "docker guard: invalid JSON body");
          return;
        }
        const check = validateContainerCreateBody(body, allowedBindSrc);
        if (!check.ok) {
          opts.onReject?.(`containers/create rejected: ${check.error}`);
          jsonError(res, 403, `docker guard: ${check.error}`);
          return;
        }
        forward(req, res, rawUrl);
      });
      req.on("error", () => {
        if (!aborted && !res.headersSent) jsonError(res, 400, "docker guard: request error");
      });
      return;
    }

    forward(req, res, rawUrl);
  });
}

/** CLI entry: node dist/sandbox/docker-guard-cli.js */
export function startDockerGuardFromEnv(): void {
  const port = Number(process.env.DOCKER_GUARD_PORT ?? 2375) || 2375;
  const socketPath = process.env.DOCKER_GUARD_SOCKET?.trim() || "/var/run/docker.sock";
  const allowedBindSrc = (process.env.CLAW2_DOCKER_GUARD_ALLOWED_BIND_SRC ?? "")
    .split(":")
    .map((p) => p.trim())
    .filter(Boolean);
  const server = createDockerGuardServer({
    socketPath,
    allowedBindSrc,
    onReject: (detail) => console.error(`[docker-guard] rejected: ${detail}`),
  });
  server.listen(port, "0.0.0.0", () => {
    console.error(
      `[docker-guard] listening on 0.0.0.0:${port} → ${socketPath}; ` +
        `bind sources: ${allowedBindSrc.length ? allowedBindSrc.join(", ") : "(none)"}`
    );
  });
}
