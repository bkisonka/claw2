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

/**
 * {id} segments: docker names/ids — AND claw2 ownership. The sandbox only
 * ever touches containers named claw2-agent-… / claw2-egress-… and networks
 * claw2-…; restricting the id segment keeps a compromised gateway from
 * killing, reading logs of, or attaching to OTHER containers on the host
 * (co-tenant databases, the proxy itself...).
 */
const SEG = "[A-Za-z0-9][A-Za-z0-9_.-]*";
/** Image references carry registry/repo:tag (node:20-alpine, ghcr.io/x/y:z). */
const IMG_SEG = "[A-Za-z0-9][A-Za-z0-9_./:-]*";
const CLAW2_SEG = "claw2[A-Za-z0-9_.-]*";

/**
 * Endpoints the claw2 skill sandbox legitimately uses via the docker CLI
 * (docker version/run/rm/kill/logs/network inspect/create, container
 * inspect/start/wait/attach). Anything else — exec, build, volume, swarm,
 * secrets, auth, image push/save — is outside the sandbox contract.
 */
const ALLOWED_ENDPOINTS: { method: string; re: RegExp }[] = [
  { method: "GET", re: /^\/_ping$/ },
  { method: "GET", re: /^\/version$/ },
  { method: "GET", re: new RegExp(`^\\/images\\/${IMG_SEG}\\/json$`) },
  { method: "POST", re: /^\/images\/create$/ },
  { method: "POST", re: /^\/containers\/create$/ },
  { method: "GET", re: new RegExp(`^\\/containers\\/${CLAW2_SEG}\\/json$`) },
  { method: "GET", re: new RegExp(`^\\/containers\\/${CLAW2_SEG}\\/logs$`) },
  { method: "POST", re: new RegExp(`^\\/containers\\/${CLAW2_SEG}\\/(start|wait|kill|attach)$`) },
  { method: "DELETE", re: new RegExp(`^\\/containers\\/${CLAW2_SEG}$`) },
  { method: "GET", re: /^\/networks$/ },
  { method: "GET", re: new RegExp(`^\\/networks\\/${CLAW2_SEG}$`) },
  { method: "POST", re: /^\/networks\/create$/ },
  { method: "POST", re: new RegExp(`^\\/networks\\/${CLAW2_SEG}\\/(connect|disconnect)$`) },
  { method: "DELETE", re: new RegExp(`^\\/networks\\/${CLAW2_SEG}$`) },
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
  if (dst.includes("..")) return `bind target must not contain "..": "${bind}"`;
  if (!dst.startsWith("/app/") && dst !== "/sidecar.cjs") {
    return `bind target must be /app/** or /sidecar.cjs: "${bind}"`;
  }
  // Docker mounts a bind WITHOUT options read-write; read-write is reserved
  // for the sandbox output mount (dst === /app/output) — anything else that
  // omitss opts (or explicitly carries rw) is rejected.
  const ro = opts === "" || opts.split(",").includes("ro");
  if (!ro && dst !== "/app/output") {
    return `binds must be read-only except the /app/output mount: "${bind}"`;
  }
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

/** Reject namespace-sharing via another container (netns/shm/pid). */
function isContainerNamespaceValue(v: unknown): boolean {
  return typeof v === "string" && (v.startsWith("container:") || v === "host" || v.startsWith("ns:"));
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

  // Container identity: sandbox containers are claw2-named (name is also
  // spoofable via ?name= — see the endpoint guard; a non-claw2 name would
  // squat co-tenant names on the daemon).
  const name = typeof b.Name === "string" ? b.Name : "";
  if (name && !name.startsWith("claw2")) {
    return { ok: false, error: "container name must start with 'claw2'" };
  }

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
    if (isContainerNamespaceValue(hc[key])) {
      return { ok: false, error: `${key} namespace sharing (host/container:*) is not allowed` };
    }
  }
  // Restart policies keep containers alive outside the operator's control.
  const restartName = (hc.RestartPolicy as { Name?: unknown } | undefined)?.Name;
  if (typeof restartName === "string" && restartName && restartName !== "no") {
    return { ok: false, error: "restart policies are not allowed" };
  }
  if (typeof hc.OomScoreAdj === "number" && hc.OomScoreAdj < 0) {
    return { ok: false, error: "OomScoreAdj < 0 is not allowed" };
  }
  for (const key of ["DeviceCgroupRules", "DeviceRequests", "GroupAdd", "Ulimits", "CgroupParent", "Dns", "DnsSearch", "DnsOptions", "ExtraHosts", "VolumesFrom"]) {
    if (isNonEmptyArray(hc[key])) return { ok: false, error: `${key} is not allowed` };
  }
  const logConfig = hc.LogConfig as { Type?: unknown } | undefined;
  if (logConfig && typeof logConfig.Type === "string" && !["json-file", "local", "none"].includes(logConfig.Type)) {
    return { ok: false, error: "LogConfig remote drivers are not allowed" };
  }
  // Tmpfs entries must be noexec and must not shadow the rootfs (a writable
  // exec tmpfs on "/" defeats ReadonlyRootfs).
  const tmpfs = hc.Tmpfs;
  if (tmpfs && typeof tmpfs === "object") {
    for (const [target, mountOpts] of Object.entries(tmpfs as Record<string, unknown>)) {
      if (target === "/") return { ok: false, error: "tmpfs over / is not allowed" };
      if (typeof mountOpts === "string" && !mountOpts.split(",").includes("noexec")) {
        return { ok: false, error: `tmpfs on ${target} must be noexec` };
      }
    }
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
  // Networks at create time: the docker CLI sends NetworkingConfig for multi
  // --network runs. Every endpoint must be a claw2-scoped network — a bridge /
  // co-tenant / control network here would bypass the --internal egress
  // isolation (and could put a sandbox container onto sandbox-control).
  const networking = b.NetworkingConfig as { EndpointsConfig?: unknown } | undefined;
  const endpoints = networking?.EndpointsConfig;
  if (endpoints && typeof endpoints === "object") {
    const names = Array.isArray(endpoints)
      ? (endpoints as { Network?: unknown }[]).map((e) => e?.Network)
      : Object.keys(endpoints as Record<string, unknown>);
    for (const net of names) {
      if (typeof net !== "string" || !net.startsWith("claw2")) {
        return { ok: false, error: `network attachment "${String(net)}" must be a claw2 network` };
      }
    }
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
  /** Own container name: container-scoped operations targeting it are refused (anti self-removal). */
  selfName?: string;
  /** Guard-side rejection hook (audit/console). */
  onReject?: (detail: string) => void;
}

/**
 * Body checks for the remaining sandbox POSTs: networks must be claw2-owned
 * bridge networks and may only connect claw2-owned containers.
 */
export function validateNetworkCreateBody(body: unknown): ContainerCreateCheck {
  const b = (body ?? {}) as { Name?: unknown; Driver?: unknown };
  if (typeof b.Name !== "string" || !b.Name.startsWith("claw2")) {
    return { ok: false, error: "network name must start with 'claw2'" };
  }
  // macvlan/host drivers put the network on a host interface — the sandbox
  // contract is plain bridge networks only.
  if (typeof b.Driver === "string" && b.Driver !== "bridge") {
    return { ok: false, error: `network driver "${b.Driver}" is not allowed` };
  }
  return { ok: true };
}

export function validateNetworkConnectBody(body: unknown): ContainerCreateCheck {
  if (!body || typeof body !== "object") return { ok: true };
  const container = (body as { Container?: unknown }).Container;
  if (typeof container === "string" && !container.startsWith("claw2")) {
    return { ok: false, error: "connect target must be a claw2 container" };
  }
  return { ok: true };
}

export function createDockerGuardServer(opts: DockerGuardServerOptions = {}): http.Server {
  const socketPath = opts.socketPath ?? "/var/run/docker.sock";
  const selfName = opts.selfName?.trim() || "claw2-docker-guard";
  const allowedBindSrc = (opts.allowedBindSrc ?? [])
    .map((p) => p.trim())
    .filter(Boolean);

  const forward = (
    req: IncomingMessage,
    res: ServerResponse,
    targetPath: string,
    // When the body was consumed for validation it MUST be re-sent explicitly:
    // piping the already-ended IncomingMessage forwards zero bytes and the
    // daemon waits for a body that never arrives (hangs the docker CLI).
    bodyBuffer?: Buffer
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
    if (bodyBuffer != null) preq.end(bodyBuffer);
    else req.pipe(preq);
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

    // Self-protection: the gateway must not be able to kill/rm/inspect its
    // own guard (a removed guard does not come back on restart policy).
    const containerScope = /^\/containers\/([^/]+)(\/|$)/.exec(path);
    if (containerScope && containerScope[1] === selfName) {
      opts.onReject?.(`self-targeted container op ${method} ${path}`);
      jsonError(res, 403, "docker guard: self-targeted operations are not allowed");
      return;
    }

    // docker load streams an arbitrary image from the request body — outside
    // the sandbox contract (pulls via ?fromImage= stay allowed).
    if (method === "POST" && path === "/images/create") {
      const q = new URL(rawUrl, "http://guard.local").searchParams;
      if (q.get("fromSrc") != null) {
        opts.onReject?.("images/create fromSrc (docker load)");
        jsonError(res, 403, "docker guard: docker load is not allowed");
        return;
      }
    }

    const guardKind =
      method === "POST" && path === "/containers/create"
        ? ("create" as const)
        : method === "POST" && path === "/networks/create"
          ? ("network-create" as const)
          : method === "POST" && /^\/networks\/claw2[A-Za-z0-9_.-]*\/(connect|disconnect)$/.test(path)
            ? ("network-connect" as const)
            : null;

    if (guardKind) {
      const chunks: Buffer[] = [];
      let total = 0;
      let aborted = false;
      req.on("data", (c: Buffer) => {
        if (aborted) return;
        total += c.length;
        if (total > MAX_CREATE_BODY_BYTES) {
          aborted = true;
          req.destroy();
          opts.onReject?.(`${path} body too large`);
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
          opts.onReject?.(`${path} invalid JSON`);
          jsonError(res, 400, "docker guard: invalid JSON body");
          return;
        }
        const check =
          guardKind === "create"
            ? validateContainerCreateBody(body, allowedBindSrc)
            : guardKind === "network-create"
              ? validateNetworkCreateBody(body)
              : validateNetworkConnectBody(body);
        if (!check.ok) {
          opts.onReject?.(`${path} rejected: ${check.error}`);
          jsonError(res, 403, `docker guard: ${check.error}`);
          return;
        }
        // Re-send the buffered body — headers alone (with their Content-Length)
        // would hang the daemon forever.
        forward(req, res, rawUrl, Buffer.concat(chunks));
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
  const selfName = process.env.CLAW2_DOCKER_GUARD_SELF_NAME?.trim() || "claw2-docker-guard";
  const allowedBindSrc = (process.env.CLAW2_DOCKER_GUARD_ALLOWED_BIND_SRC ?? "")
    .split(":")
    .map((p) => p.trim())
    .filter(Boolean);
  const server = createDockerGuardServer({
    socketPath,
    allowedBindSrc,
    selfName,
    onReject: (detail) => console.error(`[docker-guard] rejected: ${detail}`),
  });
  server.listen(port, "0.0.0.0", () => {
    console.error(
      `[docker-guard] listening on 0.0.0.0:${port} → ${socketPath}; ` +
        `bind sources: ${allowedBindSrc.length ? allowedBindSrc.join(", ") : "(none)"}`
    );
  });
}
