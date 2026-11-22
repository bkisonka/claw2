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
/** Image references carry registry/repo:tag (node:20-alpine, ghcr.io/x/y:z). */
const IMG_SEG = "[A-Za-z0-9][A-Za-z0-9_./:-]*";
const CLAW2_SEG = "claw2[A-Za-z0-9_.-]*";
const AGENT_NAME = /^claw2-agent-[A-Za-z0-9_.-]+$/;
export const SKILL_EGRESS_NETWORK = "claw2-skill-egress";
export const SIDECAR_UPSTREAM_NETWORK = "claw2-egress-upstream";
export const EGRESS_SIDECAR_NAME = "claw2-egress-sidecar";
type EgressNetwork = typeof SKILL_EGRESS_NETWORK | typeof SIDECAR_UPSTREAM_NETWORK;

function isEgressNetwork(name: unknown): name is EgressNetwork {
  return name === SKILL_EGRESS_NETWORK || name === SIDECAR_UPSTREAM_NETWORK;
}

/**
 * Endpoints the claw2 skill sandbox legitimately uses via the docker CLI
 * (docker version/run/rm/kill/logs/network inspect/create, container
 * inspect/start/wait/attach). Anything else — exec, build, volume, swarm,
 * secrets, auth, image push/save — is outside the sandbox contract.
 */
const ALLOWED_ENDPOINTS: { method: string; re: RegExp }[] = [
  { method: "GET", re: /^\/_ping$/ },
  { method: "HEAD", re: /^\/_ping$/ },
  { method: "GET", re: /^\/version$/ },
  { method: "GET", re: new RegExp(`^\\/images\\/${IMG_SEG}\\/json$`) },
  { method: "POST", re: /^\/images\/create$/ },
  { method: "POST", re: /^\/containers\/create$/ },
  { method: "GET", re: new RegExp(`^\\/containers\\/${CLAW2_SEG}\\/json$`) },
  { method: "GET", re: new RegExp(`^\\/containers\\/${CLAW2_SEG}\\/logs$`) },
  { method: "POST", re: new RegExp(`^\\/containers\\/${CLAW2_SEG}\\/(start|wait|kill|attach)$`) },
  { method: "DELETE", re: new RegExp(`^\\/containers\\/${CLAW2_SEG}$`) },
  { method: "GET", re: /^\/networks$/ },
  { method: "GET", re: /^\/networks\/(claw2-skill-egress|claw2-egress-upstream)$/ },
  { method: "POST", re: /^\/networks\/create$/ },
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasNonCanonicalField(body: Record<string, unknown>, ...canonical: string[]): boolean {
  return Object.keys(body).some((key) => canonical.some((field) => key !== field && key.toLowerCase() === field.toLowerCase()));
}

function validateContainerNetworks(
  body: Record<string, unknown>,
  hostConfig: Record<string, unknown>,
  name: string,
): ContainerCreateCheck {
  if (hasNonCanonicalField(body, "HostConfig", "NetworkingConfig") || hasNonCanonicalField(hostConfig, "NetworkMode")) {
    return { ok: false, error: "invalid network configuration field names" };
  }
  // The CLI uses the skill network as the primary network for both roles.
  if (hostConfig.NetworkMode !== SKILL_EGRESS_NETWORK) {
    return { ok: false, error: `NetworkMode must be ${SKILL_EGRESS_NETWORK}` };
  }
  const networking = body.NetworkingConfig;
  if (networking != null && (!isRecord(networking) || hasNonCanonicalField(networking, "EndpointsConfig"))) {
    return { ok: false, error: "invalid NetworkingConfig" };
  }
  const endpoints = networking?.EndpointsConfig;
  if (endpoints != null && !isRecord(endpoints)) {
    return { ok: false, error: "invalid EndpointsConfig" };
  }
  const hasUpstream = name === EGRESS_SIDECAR_NAME;
  const names = Object.keys(endpoints ?? {});
  if (names.some((net) => net !== SKILL_EGRESS_NETWORK && (!hasUpstream || net !== SIDECAR_UPSTREAM_NETWORK))) {
    return { ok: false, error: "network attachment is not allowed for this container role" };
  }
  if (hasUpstream && (!names.includes(SKILL_EGRESS_NETWORK) || !names.includes(SIDECAR_UPSTREAM_NETWORK))) {
    return { ok: false, error: "egress sidecar must join both egress networks" };
  }
  // A single-network CLI create can send an empty EndpointsConfig and rely
  // on NetworkMode. If an endpoint includes a network ID, do not accept it
  // in place of the approved network name.
  for (const net of names) {
    const endpoint = endpoints?.[net];
    if (!isRecord(endpoint) || hasNonCanonicalField(endpoint, "NetworkID") ||
        (endpoint.NetworkID != null && endpoint.NetworkID !== "")) {
      return { ok: false, error: "network endpoints must use the approved names, not network IDs" };
    }
  }
  return { ok: true };
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
  // Docker mounts a bind WITHOUT a mode option READ-WRITE ("src:/dst" is rw),
  // so the mode must be explicit: every bind except the sandbox output mount
  // (dst === /app/output) must carry "ro" and must not carry "rw". Mount
  // propagation that could leak host mounts (shared/rshared) is refused too.
  const flags = opts === "" ? [] : opts.split(",").map((f) => f.trim()).filter(Boolean);
  if (flags.includes("shared") || flags.includes("rshared")) {
    return `bind mount propagation (shared/rshared) is not allowed: "${bind}"`;
  }
  const isRo = flags.includes("ro");
  const isRw = flags.includes("rw");
  if (dst !== "/app/output" && (!isRo || isRw)) {
    return `binds must explicitly mount read-only ("...:ro") except the /app/output mount: "${bind}"`;
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
  allowedSrcPrefixes: string[],
  name: string | null,
): ContainerCreateCheck {
  if (!isRecord(body) || !isRecord(body.HostConfig)) {
    return { ok: false, error: "container create body and HostConfig required" };
  }
  const b = body;
  const hc = body.HostConfig;

  // Docker gets the name from the create URL, not the request body.
  if (!name || (name !== EGRESS_SIDECAR_NAME && !AGENT_NAME.test(name))) {
    return { ok: false, error: "container name must identify a skill or the egress sidecar" };
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
  const networks = validateContainerNetworks(b, hc, name);
  if (!networks.ok) return networks;

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

export function validateNetworkCreateBody(body: unknown): ContainerCreateCheck {
  if (!isRecord(body) || !isEgressNetwork(body.Name)) {
    return { ok: false, error: "network name must be one of the two egress networks" };
  }
  if (body.Driver !== "bridge" || body.Internal !== (body.Name === SKILL_EGRESS_NETWORK)) {
    return { ok: false, error: `${body.Name} requires bridge driver and Internal=${body.Name === SKILL_EGRESS_NETWORK}` };
  }
  // Accept the plain Docker CLI bridge profile, not network-driver options
  // or alternate network types. Reject differently cased fields too, since
  // Docker decodes Go struct field names case-insensitively.
  const fields = new Set([
    "Name", "Driver", "Internal", "Scope", "IPAM", "Attachable", "Ingress", "ConfigOnly",
    "ConfigFrom", "Options", "Labels", "EnableIPv4", "EnableIPv6", "CheckDuplicate",
  ]);
  const emptyObject = (value: unknown) => value == null || (isRecord(value) && Object.keys(value).length === 0);
  const ipam = body.IPAM;
  if (Object.keys(body).some((key) => !fields.has(key)) ||
      (body.Scope != null && body.Scope !== "" && body.Scope !== "local") ||
      [body.Attachable, body.Ingress, body.ConfigOnly].some((value) => value != null && value !== false) ||
      body.ConfigFrom != null || !emptyObject(body.Options) ||
      (ipam != null && (!isRecord(ipam) || Object.keys(ipam).some((key) => !["Driver", "Options", "Config"].includes(key)) ||
        (ipam.Driver != null && ipam.Driver !== "" && ipam.Driver !== "default") || !emptyObject(ipam.Options) ||
        (ipam.Config != null && (!Array.isArray(ipam.Config) || ipam.Config.length !== 0))))) {
    return { ok: false, error: "network create requires the default local bridge configuration" };
  }
  return { ok: true };
}

/** Check Docker's actual network inspect response, not just the requested name. */
export function validateEgressNetworkInfo(info: unknown, name: EgressNetwork): ContainerCreateCheck {
  if (!isRecord(info) || info.Name !== name || info.Driver !== "bridge" || info.Scope !== "local" ||
      info.Internal !== (name === SKILL_EGRESS_NETWORK) || info.ConfigOnly === true || info.Ingress === true) {
    return { ok: false, error: `${name} must be a local bridge with Internal=${name === SKILL_EGRESS_NETWORK}` };
  }
  return { ok: true };
}

function inspectEgressNetwork(socketPath: string, name: EgressNetwork): Promise<ContainerCreateCheck> {
  return new Promise((resolve) => {
    const request = http.get({ socketPath, path: `/networks/${name}` }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve({ ok: false, error: `cannot inspect docker network ${name} (HTTP ${res.statusCode})` });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_CREATE_BODY_BYTES) request.destroy(new Error("network inspect response too large"));
        else chunks.push(chunk);
      });
      res.on("error", () => resolve({ ok: false, error: `cannot read docker network ${name}` }));
      res.on("end", () => {
        try {
          resolve(validateEgressNetworkInfo(JSON.parse(Buffer.concat(chunks).toString("utf-8")), name));
        } catch {
          resolve({ ok: false, error: `invalid inspect response for docker network ${name}` });
        }
      });
    });
    request.setTimeout(5_000, () => request.destroy(new Error("network inspect timed out")));
    request.on("error", () => resolve({ ok: false, error: `cannot inspect docker network ${name}` }));
  });
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

    const guardKind = method === "POST" && (path === "/containers/create" || path === "/networks/create");

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
      req.on("end", async () => {
        if (aborted) return;
        const buffer = Buffer.concat(chunks);
        let body: unknown;
        try {
          body = JSON.parse(buffer.toString("utf-8"));
        } catch {
          opts.onReject?.(`${path} invalid JSON`);
          jsonError(res, 400, "docker guard: invalid JSON body");
          return;
        }
        const reject = (check: ContainerCreateCheck) => {
          opts.onReject?.(`${path} rejected: ${check.error}`);
          jsonError(res, 403, `docker guard: ${check.error}`);
        };
        if (path === "/containers/create") {
          const names = new URLSearchParams(rawUrl.slice(rawUrl.indexOf("?") + 1)).getAll("name");
          const name = names.length === 1 ? names[0] : null;
          const check = validateContainerCreateBody(body, allowedBindSrc, name === selfName ? null : name);
          if (!check.ok) return reject(check);
          const inner = await inspectEgressNetwork(socketPath, SKILL_EGRESS_NETWORK);
          if (!inner.ok) return reject(inner);
          if (name === EGRESS_SIDECAR_NAME) {
            const outer = await inspectEgressNetwork(socketPath, SIDECAR_UPSTREAM_NETWORK);
            if (!outer.ok) return reject(outer);
          }
        } else {
          const check = validateNetworkCreateBody(body);
          if (!check.ok) return reject(check);
        }
        // Re-send the buffered body — headers alone (with their Content-Length)
        // would hang the daemon forever.
        if (!res.destroyed) forward(req, res, rawUrl, buffer);
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
