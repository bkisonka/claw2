// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Run the agent script in Docker-sandbox or on the host (useDocker: false).
 * Default policy: write only to agents/output (in the container - /app/output).
 * On the host - Node --permission; optional sandbox.hostFs (allowlist | full).
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve, relative } from "node:path";
import type { Claw2Config } from "../config/types.js";
import {
  SKILL_EGRESS_NETWORK as EGRESS_NET,
  SIDECAR_UPSTREAM_NETWORK as EGRESS_UPSTREAM_NET,
  EGRESS_SIDECAR_NAME as EGRESS_SIDECAR,
  validateEgressNetworkInfo,
} from "./docker-guard.js";
import { getEgressGuardProxy } from "./egress-proxy.js";
import { ensureEgressPreload, ensureEgressSidecar } from "./egress-preload-build.js";

/**
 * Sibling-sandbox mode (compose delivery): the gateway runs inside a
 * container and launches skill containers on the HOST docker through a
 * restricted API proxy (DOCKER_HOST). Container paths (/app/…) must be
 * mapped to host paths for sibling binds. The compose stack names the
 * gateway's own container (CLAW2_SIBLING_SOURCE_CONTAINER) and the host
 * paths are read from its mounts on the daemon — see siblingMounts().
 * CLAW2_SIBLING_HOST_ROOT is the older flat mapping (/app/… → one root).
 * Without either, skill containers are started with mounts from the
 * gateway's own filesystem (host-installed gateway, where container paths
 * == host paths).
 */
function siblingHostRoot(): string {
  return process.env.CLAW2_SIBLING_HOST_ROOT?.trim() ?? "";
}

/** The gateway's own container (compose: container_name); its binds are the sibling bind sources. */
function siblingSourceContainer(): string {
  return process.env.CLAW2_SIBLING_SOURCE_CONTAINER?.trim() ?? "";
}

/** Absolute path without symlink (on macOS /tmp → /private/tmp) - otherwise --allow-fs-* does not match.*/
function realAbs(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Expand ~ ; keep Node permission wildcard `*`. */
export function expandHostFsPath(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  if (t === "*") return "*";
  if (t === "~") return resolve(homedir());
  if (t.startsWith("~/") || t.startsWith("~\\")) {
    return resolve(homedir(), t.slice(2));
  }
  return resolve(t);
}

/**
 * Paths to pass to --allow-fs-*. On macOS /tmp and /private/tmp are distinct to the
 * permission model, so both forms are listed when applicable.
 */
export function fsPermissionPathVariants(pathOrStar: string): string[] {
  if (pathOrStar === "*") return ["*"];
  const abs = expandHostFsPath(pathOrStar);
  if (!abs) return [];
  const real = realAbs(abs);
  const set = new Set<string>([abs, real]);
  for (const p of [...set]) {
    if (p.startsWith("/private/tmp")) set.add(p.slice("/private".length));
    else if (p === "/private/tmp") set.add("/tmp");
    if (p.startsWith("/tmp/") || p === "/tmp") set.add(p === "/tmp" ? "/private/tmp" : `/private${p}`);
  }
  return [...set];
}

/** Checks that the normalized script name does not extend beyond agentsDir (path traversal protection).*/
function resolveScriptPath(agentsDir: string, scriptRaw: string): { path: string; error?: string } {
  const script = scriptRaw.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!script || script.includes("..")) {
    return { path: "", error: "script path must be inside agents directory" };
  }
  const fullPath = resolve(agentsDir, script);
  const rel = relative(agentsDir, fullPath);
  if (rel.startsWith("..") || rel.includes("..")) {
    return { path: "", error: "script path must be inside agents directory" };
  }
  return { path: script };
}

export interface RunAgentOptions {
  script: string;
  args?: string[];
  stdin?: string;
  env?: Record<string, string>;
  /** Download directory (attached files); mounted in the container as /app/uploads*/
  uploadsDir?: string;
  /** The only place to record agent output is agents/output; in the container it is mounted as /app/output*/
  outputDir?: string;
}

export interface RunAgentResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

let cachedPermissionSupport: { bin: string; ok: boolean } | null = null;

/** Prefer bundled/desktop Node (CLAW2_NODE_BIN), else PATH `node`. */
export function resolveHostNodeBin(): string {
  const fromEnv = process.env.CLAW2_NODE_BIN?.trim();
  if (fromEnv) return fromEnv;
  return "node";
}

/** Node --permission is available (Node 20+).*/
function nodeSupportsPermission(nodeBin: string = resolveHostNodeBin()): boolean {
  if (cachedPermissionSupport?.bin === nodeBin) return cachedPermissionSupport.ok;
  try {
    const r = spawnSync(nodeBin, ["--permission", "-e", ""], {
      encoding: "utf-8",
      timeout: 5_000,
    });
    const ok = r.status === 0;
    cachedPermissionSupport = { bin: nodeBin, ok };
    return ok;
  } catch {
    cachedPermissionSupport = { bin: nodeBin, ok: false };
    return false;
  }
}

/**
 * Build Node --permission flags for host agents.
 * Default: read agents (+ uploads + dependency roots), write output only.
 * hostFs.mode=allowlist adds read[]/write[]; mode=full → *.
 *
 * Dependency roots: agents/node_modules (and its realpath when symlinked, e.g.
 * ~/.claw2/agents/node_modules → repo agents/node_modules), plus NODE_PATH entries.
 */
export function buildHostPermissionArgs(
  config: Claw2Config,
  agentsDir: string,
  outputDir: string,
  uploadsDir?: string
): string[] {
  if (!nodeSupportsPermission()) return [];

  const hostFs = config.sandbox?.hostFs;
  const mode = hostFs?.mode ?? "default";

  if (mode === "full") {
    return ["--permission", "--allow-fs-read=*", "--allow-fs-write=*"];
  }

  const reads = new Set<string>();
  const writes = new Set<string>();
  for (const p of fsPermissionPathVariants(agentsDir)) reads.add(p);
  for (const p of fsPermissionPathVariants(outputDir)) writes.add(p);
  if (uploadsDir) {
    for (const p of fsPermissionPathVariants(uploadsDir)) reads.add(p);
  }

  // Skill deps (pdf-parse, etc.): allow node_modules even when symlinked outside agentsDir.
  for (const depRoot of collectHostAgentDependencyRoots(agentsDir)) {
    for (const p of fsPermissionPathVariants(depRoot)) reads.add(p);
  }

  if (mode === "allowlist") {
    for (const p of hostFs?.read ?? []) {
      for (const v of fsPermissionPathVariants(p)) reads.add(v);
    }
    for (const p of hostFs?.write ?? []) {
      const expanded = expandHostFsPath(p);
      if (!expanded) continue;
      if (expanded !== "*") {
        try {
          mkdirSync(expanded, { recursive: true });
        } catch {
          /* ignore */
        }
      }
      for (const v of fsPermissionPathVariants(expanded)) writes.add(v);
    }
  }

  const args = ["--permission"];
  for (const p of reads) args.push(`--allow-fs-read=${p}`);
  for (const p of writes) args.push(`--allow-fs-write=${p}`);
  return args;
}

/** Roots that host skills may need to read for require/import (node_modules / NODE_PATH). */
export function collectHostAgentDependencyRoots(agentsDir: string): string[] {
  const roots = new Set<string>();
  const add = (p: string) => {
    const t = p.trim();
    if (!t || t === "*") return;
    roots.add(resolve(t));
    try {
      if (existsSync(t)) roots.add(realpathSync(t));
    } catch {
      /* ignore */
    }
  };

  add(join(agentsDir, "node_modules"));

  const nodePath = process.env.NODE_PATH ?? "";
  for (const part of nodePath.split(delimiter)) {
    if (part.trim()) add(part);
  }

  const repoRoot = process.env.CLAW2_REPO_ROOT?.trim();
  if (repoRoot) {
    add(join(repoRoot, "agents", "node_modules"));
    add(join(repoRoot, "node_modules"));
  }

  return [...roots];
}

const EGRESS_SIDECAR_PORT = 3128;

function dockerSpawnSync(args: string[], timeoutMs = 15_000): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("docker", args, { encoding: "utf-8", timeout: timeoutMs });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Container paths whose host counterparts (the gateway's binds) a skill may receive. */
const SANDBOX_MOUNTS = ["/app/agents", "/app/data"];

let cachedSiblingMounts: { container: string; mounts: Map<string, string> } | null = null;

/**
 * Sandbox mounts from `docker container inspect -f <template>` output, one
 * `type<TAB>destination<TAB>source` line per mount.
 */
export function parseSiblingMounts(output: string): Map<string, string> {
  const mounts = new Map<string, string>();
  for (const line of output.split("\n")) {
    const [type, destination, source] = line.split("\t");
    // Bind mounts only: a named volume's source is a volume name, not a host path.
    if (type === "bind" && destination && SANDBOX_MOUNTS.includes(destination) && source?.startsWith("/")) {
      mounts.set(destination, source);
    }
  }
  return mounts;
}

// Go templates keep escapes only inside quoted strings: a bare \t between the
// fields is printed as two characters and every mount goes unparsed.
const SIBLING_MOUNTS_TEMPLATE =
  '{{range .Mounts}}{{.Type}}{{"\\t"}}{{.Destination}}{{"\\t"}}{{.Source}}{{"\\n"}}{{end}}';

/**
 * Container path → host path for the sandbox mounts, read from the gateway
 * container itself on the daemon. The container cannot learn the host path of
 * its volumes otherwise (${PWD} in compose is the caller's directory, not
 * the project's — launched from elsewhere, it made the daemon create empty
 * root-owned directories in place of the bind sources and every skill died
 * on `--require /app/.claw2-egress-preload.cjs`). The daemon's view of this
 * very container cannot drift from its volumes. Cached per container: mounts
 * do not change while it lives. `error` is set when the container is named
 * but cannot be read — the caller must then refuse to bind anything.
 */
function siblingMounts(): { mounts: Map<string, string>; error?: string } {
  const container = siblingSourceContainer();
  if (!container) return { mounts: new Map() };
  if (cachedSiblingMounts?.container === container) return { mounts: cachedSiblingMounts.mounts };
  const r = dockerSpawnSync(["container", "inspect", "-f", SIBLING_MOUNTS_TEMPLATE, container]);
  if (r.status !== 0) {
    return {
      mounts: new Map(),
      error: `cannot read the mounts of container ${container}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`,
    };
  }
  const mounts = parseSiblingMounts(r.stdout);
  cachedSiblingMounts = { container, mounts };
  return { mounts };
}

/** Everything sibling binds are made of; `enabled` is false on a host-installed gateway. */
interface SiblingPaths {
  enabled: boolean;
  hostRoot: string;
  mounts: ReadonlyMap<string, string>;
  error?: string;
}

function siblingPaths(): SiblingPaths {
  const hostRoot = siblingHostRoot();
  if (hostRoot && !hostRoot.startsWith("/")) {
    return { enabled: true, hostRoot, mounts: new Map(), error: "CLAW2_SIBLING_HOST_ROOT must be an absolute HOST path" };
  }
  if (!hostRoot && !siblingSourceContainer()) return { enabled: false, hostRoot, mounts: new Map() };
  const { mounts, error } = siblingMounts();
  return { enabled: true, hostRoot, mounts, error };
}

/**
 * Host path for a container path under the sandbox mounts. The gateway's own
 * mounts win (longest match); CLAW2_SIBLING_HOST_ROOT is the flat fallback
 * for layouts without them. Anything else is null — a wrong directory must
 * never be bound in silence.
 */
export function mapSandboxPathToHost(
  src: string,
  mounts: ReadonlyMap<string, string>,
  hostRoot: string
): string | null {
  let mount: { destination: string; source: string } | null = null;
  for (const [destination, source] of mounts) {
    if (destination.length > (mount?.destination.length ?? 0) && (src === destination || src.startsWith(`${destination}/`))) {
      mount = { destination, source };
    }
  }
  if (mount) {
    const rel = relative(mount.destination, src);
    return rel === "" ? mount.source : join(mount.source, rel);
  }
  if (hostRoot) {
    if (src === "/app") return hostRoot;
    if (src.startsWith("/app/")) return hostRoot + src.slice("/app".length);
  }
  return null;
}

/** Never reuse (or replace) an existing network whose properties do not match. */
function ensureDockerNetwork(name: typeof EGRESS_NET | typeof EGRESS_UPSTREAM_NET): { ok: true } | { ok: false; error: string } {
  let inspect = dockerSpawnSync(["network", "inspect", name]);
  if (inspect.status !== 0) {
    const args = ["network", "create", "--driver", "bridge"];
    if (name === EGRESS_NET) args.push("--internal");
    const created = dockerSpawnSync([...args, name]);
    // Re-inspect even when create failed: another runner may have created it.
    inspect = dockerSpawnSync(["network", "inspect", name]);
    if (inspect.status !== 0) {
      const detail = (created.stderr || inspect.stderr).trim().slice(0, 200);
      return { ok: false, error: `cannot ensure docker network ${name}: ${detail}` };
    }
  }
  try {
    const networks: unknown = JSON.parse(inspect.stdout);
    if (Array.isArray(networks) && networks.length === 1) {
      const check = validateEgressNetworkInfo(networks[0], name);
      if (check.ok) return { ok: true };
      return { ok: false, error: check.error ?? `unexpected properties for docker network ${name}` };
    }
  } catch {
    // Invalid daemon responses are not treated as evidence of isolation.
  }
  return { ok: false, error: `invalid inspect result for docker network ${name}` };
}

interface DockerEgressPrep {
  ok: true;
  dockerArgs: string[];
  env: Record<string, string>;
  nodeArgs: string[];
}

/**
 * Hard-tier egress setup for a docker-sandbox skill run:
 *   - skill containers join the --internal network `claw2-skill-egress`
 *     (no external route at all — kernel-enforced);
 *   - a sidecar container on that network (+ a normal bridge for its own
 *     upstream) runs the guard proxy and is the skills' only egress point;
 *   - the mounted preload routes the skill's fetch/http/https into it.
 * Nothing is published to the host; works identically on Linux and
 * Docker Desktop.
 *
 * Sibling mode (gateway itself runs in a container, CLAW2_SIBLING_SOURCE_
 * CONTAINER or CLAW2_SIBLING_HOST_ROOT set): binds must use HOST paths, so
 * the preload is staged through the host-visible data mount (/app/data →
 * its host path) and the sidecar runs from the claw2 image itself (the
 * bundle lives in dist/ inside the image).
 */
async function prepareDockerEgress(config: Claw2Config): Promise<DockerEgressPrep | { ok: false; error: string }> {
  const preload = ensureEgressPreload();
  if (!preload.ok) return { ok: false, error: preload.error };
  const sibling = siblingPaths();
  if (sibling.error) return { ok: false, error: sibling.error };

  const image = config.sandbox?.image ?? "node:20-alpine";
  const netErr = ensureDockerNetwork(EGRESS_NET);
  if (!netErr.ok) return { ok: false, error: netErr.error };
  const upErr = ensureDockerNetwork(EGRESS_UPSTREAM_NET);
  if (!upErr.ok) return { ok: false, error: upErr.error };

  // Preload for the skill container: in sibling mode stage it to the
  // host-visible data mount (the gateway's dist/ is not a host path).
  let preloadBindSrc = preload.path;
  if (sibling.enabled) {
    try {
      copyFileSync(preload.path, "/app/data/egress-preload.cjs");
    } catch (err) {
      return {
        ok: false,
        error: `cannot stage egress preload to /app/data (sibling mode): ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const staged = mapSandboxPathToHost("/app/data/egress-preload.cjs", sibling.mounts, sibling.hostRoot);
    if (staged === null) {
      return {
        ok: false,
        error:
          "cannot map /app/data/egress-preload.cjs to a host path: the gateway container has no bind mount at /app/data and CLAW2_SIBLING_HOST_ROOT is not set",
      };
    }
    preloadBindSrc = staged;
  }

  // Sidecar: reuse a running one with the same egress settings, (re)start
  // otherwise. Readiness is the container's own HEALTHCHECK — the restricted
  // API proxy does not need (and does not grant) exec.
  const allowPrivate = config.sandbox?.egress?.allowPrivateHosts === true ? "1" : "0";
  const sidecarStatus = dockerSpawnSync(["container", "inspect", "-f", "{{.State.Running}}", EGRESS_SIDECAR]);
  const sidecarRunning = sidecarStatus.status === 0 && sidecarStatus.stdout.trim() === "true";
  let sidecarEnvMatches = false;
  if (sidecarRunning) {
    const label = dockerSpawnSync([
      "container",
      "inspect",
      "-f",
      "{{index .Config.Labels \"claw2.egress.allow-private\"}}",
      EGRESS_SIDECAR,
    ]);
    // Older sidecars have no label at all — treat as stale and recreate.
    sidecarEnvMatches = label.status === 0 && label.stdout.trim() === allowPrivate;
  }
  let sidecarNetworksMatch = false;
  if (sidecarRunning && sidecarEnvMatches) {
    const networks = dockerSpawnSync([
      "container", "inspect", "-f", "{{json .NetworkSettings.Networks}}", EGRESS_SIDECAR,
    ]);
    if (networks.status === 0) {
      try {
        const attached = Object.keys(JSON.parse(networks.stdout));
        sidecarNetworksMatch = attached.length === 2 && attached.includes(EGRESS_NET) && attached.includes(EGRESS_UPSTREAM_NET);
      } catch {
        // Missing/malformed attachment data is not a match.
      }
    }
  }
  // The sidecar outlives `compose up --build`: containers pin the image ID
  // they were created from, so after an update the tag points at a new image
  // while the running sidecar still executes the old one. Recreate when the
  // running container's image no longer equals the current tag's image.
  let sidecarImageMatches = false;
  if (sidecarRunning && sidecarEnvMatches && sidecarNetworksMatch) {
    const sidecarImage = dockerSpawnSync(["container", "inspect", "-f", "{{.Image}}", EGRESS_SIDECAR]);
    const currentImage = dockerSpawnSync(["image", "inspect", "-f", "{{.Id}}", image]);
    sidecarImageMatches =
      sidecarImage.status === 0 &&
      currentImage.status === 0 &&
      sidecarImage.stdout.trim() === currentImage.stdout.trim();
  }
  if (!sidecarRunning || !sidecarEnvMatches || !sidecarNetworksMatch || !sidecarImageMatches) {
    dockerSpawnSync(["rm", "-f", EGRESS_SIDECAR]);
    const sidecarCmd = [
      "run",
      "-d",
      "--name",
      EGRESS_SIDECAR,
      // Internal net: reachable by skill containers, no external route.
      // Upstream net (user-defined, non-internal): the sidecar's own path to
      // the internet. Docker refuses default "bridge" alongside a
      // user-defined network, hence the dedicated one.
      "--network",
      EGRESS_NET,
      "--network",
      EGRESS_UPSTREAM_NET,
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=16m",
      "-e",
      `CLAW2_EGRESS_ALLOW_PRIVATE=${allowPrivate}`,
      // Readiness lives in the container itself; the gateway only inspects
      // health state — no exec into containers through the API proxy.
      "--health-cmd",
      `node -e "fetch('http://127.0.0.1:${EGRESS_SIDECAR_PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`,
      "--health-interval",
      "2s",
      "--health-retries",
      "20",
      "--health-start-period",
      "1s",
      "--label",
      `claw2.egress.allow-private=${allowPrivate}`,
    ];
    if (sibling.enabled) {
      // Sibling mode: the claw2 image carries dist/egress-sidecar.cjs.
      sidecarCmd.push(image, "node", "/app/dist/egress-sidecar.cjs");
    } else {
      const sidecar = ensureEgressSidecar();
      if (!sidecar.ok) return { ok: false, error: sidecar.error };
      sidecarCmd.push("-v", `${sidecar.path}:/sidecar.cjs:ro`, image, "node", "/sidecar.cjs");
    }
    const started = dockerSpawnSync(sidecarCmd);
    if (started.status !== 0) {
      // Do not start a stale container whose networks/settings were not verified.
      return { ok: false, error: `cannot start egress sidecar: ${started.stderr.trim().slice(0, 200)}` };
    }
    // Wait for readiness: container HEALTHCHECK → healthy.
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      const st = dockerSpawnSync(["container", "inspect", "-f", "{{.State.Health.Status}}", EGRESS_SIDECAR]);
      ready = st.status === 0 && st.stdout.trim() === "healthy";
      if (!ready) await new Promise((r) => setTimeout(r, 300));
    }
    if (!ready) {
      const logs = dockerSpawnSync(["logs", EGRESS_SIDECAR]);
      return { ok: false, error: `egress sidecar did not become healthy: ${logs.stdout.trim().slice(0, 200)}` };
    }
  }

  const proxyUrl = `http://${EGRESS_SIDECAR}:${EGRESS_SIDECAR_PORT}`;
  return {
    ok: true,
    dockerArgs: [
      "--network",
      EGRESS_NET,
      "-v",
      `${preloadBindSrc}:/app/.claw2-egress-preload.cjs:ro`,
    ],
    env: {
      CLAW2_EGRESS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
    },
    nodeArgs: ["--require", "/app/.claw2-egress-preload.cjs"],
  };
}

function dockerUnavailableMessage(detail?: string): string {
  const hint =
    process.env.CLAW2_DESKTOP === "1"
      ? " On desktop set sandbox.useDocker: false (host sandbox with Node --permission) or install Docker Desktop and keep useDocker: true."
      : " When running claw2 inside Docker, set sandbox.useDocker: false so agents run with Node in the same container.";
  const extra = detail ? ` (${detail})` : "";
  return `Error: Docker is not available${extra}.${hint}`;
}

/** Docker CLI + daemon available.*/
export function isDockerAvailable(): { ok: boolean; detail?: string } {
  try {
    const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      encoding: "utf-8",
      timeout: 8_000,
    });
    if (r.error) {
      const code = (r.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { ok: false, detail: "docker not found" };
      return { ok: false, detail: r.error.message };
    }
    if (r.status !== 0) {
      const msg = (r.stderr || r.stdout || "daemon unavailable").trim().slice(0, 200);
      return { ok: false, detail: msg || "daemon unavailable" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Runs a script on the host (node ​​in agentsDir).
 * Used when sandbox.useDocker === false (desktop default) or elevated session.
 * With --permission (+ optional sandbox.hostFs); network allowed; without child_process.
 * Env: only PATH and explicitly passed options.env (not the whole process.env).
 */
export async function runAgentHost(
  config: Claw2Config,
  options: RunAgentOptions
): Promise<RunAgentResult> {
  const agentsDir = resolve(config.agentsDir ?? "agents");
  const outputDir = options.outputDir ?? resolve(agentsDir, "output");
  const timeoutMs = config.sandbox?.timeoutMs ?? 60_000;
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  const scriptRes = resolveScriptPath(agentsDir, options.script);
  if (scriptRes.error) {
    return Promise.resolve({
      stdout: "",
      stderr: `Error: ${scriptRes.error}`,
      exitCode: -1,
    });
  }
  const script = scriptRes.path;
  const args = options.args ?? [];
  const agentsReal = realAbs(agentsDir);
  const outputReal = realAbs(outputDir);
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  env.OUTPUT_DIR = outputReal;
  if (process.env.NODE_PATH) env.NODE_PATH = process.env.NODE_PATH;
  if (options.env && typeof options.env === "object") {
    for (const [k, v] of Object.entries(options.env)) if (typeof v === "string") env[k] = v;
  }

  const nodeBin = resolveHostNodeBin();
  const perm = buildHostPermissionArgs(config, agentsReal, outputReal, options.uploadsDir);
  if (perm.length === 0) {
    return {
      stdout: "",
      stderr:
        `Error: Node --permission is required for host sandbox, but this Node build does not support it (${nodeBin}). Use Docker (sandbox.useDocker: true), set CLAW2_NODE_BIN to Node 20+, or upgrade Node.`,
      exitCode: -1,
    };
  }

  // Egress guard, soft tier (default on): the skill's fetch/http/https is
  // routed through the gateway's guard proxy with the same SSRF rules as
  // web_fetch — loopback/private/link-local/metadata destinations are blocked
  // and audited. Standard HTTP stacks only: raw node:net/node:tls sockets are
  // a documented gap here (kernel-level isolation is the Docker tier's job).
  const egressMode = config.sandbox?.egress?.mode ?? "guard";
  let egressNodeArgs: string[] = [];
  if (egressMode === "guard") {
    const preload = ensureEgressPreload();
    if (!preload.ok) {
      return {
        stdout: "",
        stderr: `Error: egress guard could not start: ${preload.error} (fail-closed; set sandbox.egress.mode: "off" to disable the guard)`,
        exitCode: -1,
      };
    }
    try {
      const guard = getEgressGuardProxy({
        config,
        allowPrivateHosts: config.sandbox?.egress?.allowPrivateHosts === true,
      });
      const port = await guard.listenOn("127.0.0.1");
      // Passed as node argv flags, NOT via NODE_OPTIONS: NODE_OPTIONS is
      // whitespace-delimited and breaks on install paths with spaces. The
      // preload must also be readable under the --permission sandbox.
      egressNodeArgs = ["--require", preload.path];
      perm.push(`--allow-fs-read=${preload.path}`);
      const preloadReal = realAbs(preload.path);
      if (preloadReal !== preload.path) perm.push(`--allow-fs-read=${preloadReal}`);
      env.CLAW2_EGRESS_PROXY = `http://127.0.0.1:${port}`;
    } catch (err) {
      return {
        stdout: "",
        stderr: `Error: egress guard proxy failed: ${err instanceof Error ? err.message : String(err)} (fail-closed; set sandbox.egress.mode: "off" to disable the guard)`,
        exitCode: -1,
      };
    }
  }

  return new Promise((resolvePromise, rejectPromise) => {
    // --no-addons closes the permission-model bypass via native modules: without
    // it a skill could require(".node") addons and escape the fs/network regime.
    const proc = spawn(nodeBin, [...perm, "--no-addons", ...egressNodeArgs, script, ...args], {
      cwd: agentsReal,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    // Cap captured output: a looping skill must not inflate memory or the prompt.
    const MAX_CAPTURE_BYTES = 256 * 1024;
    let captured = 0;
    let errCaptured = 0;
    let truncated = false;
    proc.stdout?.on("data", (c: Buffer) => {
      if (captured >= MAX_CAPTURE_BYTES) return;
      const room = MAX_CAPTURE_BYTES - captured;
      captured += c.length;
      chunks.push(c.length > room ? c.subarray(0, room) : c);
      if (captured >= MAX_CAPTURE_BYTES) truncated = true;
    });
    proc.stderr?.on("data", (c: Buffer) => {
      if (errCaptured >= MAX_CAPTURE_BYTES) return;
      const room = MAX_CAPTURE_BYTES - errCaptured;
      errCaptured += c.length;
      errChunks.push(c.length > room ? c.subarray(0, room) : c);
    });
    let settled = false;
    const settle = (result: RunAgentResult) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      settle({
        stdout: Buffer.concat(chunks).toString("utf-8") + (truncated ? "\n[output truncated]\n" : ""),
        stderr: Buffer.concat(errChunks).toString("utf-8") + "\n[timeout]\n",
        exitCode: -1,
      });
    }, timeoutMs);
    if (options.stdin !== undefined) proc.stdin?.end(options.stdin, "utf-8");
    else proc.stdin?.end();
    proc.on("error", (err) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        rejectPromise(err);
      }
    });
    proc.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (settled) return;
      settle({
        stdout: Buffer.concat(chunks).toString("utf-8") + (truncated ? "\n[output truncated]\n" : ""),
        stderr: Buffer.concat(errChunks).toString("utf-8"),
        exitCode: code ?? (signal ? -1 : 0),
      });
    });
  });
}

/**
 * Runs a script in a container. Disk writing is only allowed in /app/output (agents/output on the host).
 */
export async function runAgent(
  config: Claw2Config,
  options: RunAgentOptions
): Promise<RunAgentResult> {
  const docker = isDockerAvailable();
  if (!docker.ok) {
    return {
      stdout: "",
      stderr: dockerUnavailableMessage(docker.detail),
      exitCode: -1,
    };
  }

  const agentsDir = resolve(config.agentsDir ?? "agents");
  const outputDir = options.outputDir ?? resolve(agentsDir, "output");
  const image = config.sandbox?.image ?? "node:20-alpine";
  const timeoutMs = config.sandbox?.timeoutMs ?? 60_000;

  mkdirSync(outputDir, { recursive: true });

  const scriptRes = resolveScriptPath(agentsDir, options.script);
  if (scriptRes.error) {
    return Promise.resolve({
      stdout: "",
      stderr: `Error: ${scriptRes.error}`,
      exitCode: -1,
    });
  }
  const script = scriptRes.path;
  const args = options.args ?? [];

  const injectedEnv: Record<string, string> = { ...options.env };
  injectedEnv.OUTPUT_DIR = "/app/output";

  // Resolved up front: a gateway that cannot map its own mounts must fail
  // before networks and the sidecar are touched.
  const sibling = siblingPaths();
  if (sibling.error) {
    return { stdout: "", stderr: `Error: ${sibling.error}; refusing to bind a wrong directory`, exitCode: -1 };
  }

  // Egress guard, hard tier (default on): the container joins a --internal
  // network — no external route at all — and reaches the guard proxy through
  // the network gateway IP (mounted preload + proxy env).
  const egressMode = config.sandbox?.egress?.mode ?? "guard";
  let egressDockerArgs: string[] = [];
  let egressNodeArgs: string[] = [];
  if (egressMode === "guard") {
    const prep = await prepareDockerEgress(config);
    if (!prep.ok) {
      return {
        stdout: "",
        stderr: `Error: egress guard (docker sandbox) failed: ${prep.error} (fail-closed; set sandbox.egress.mode: "off" to disable the guard)`,
        exitCode: -1,
      };
    }
    egressDockerArgs = prep.dockerArgs;
    // argv flags, not NODE_OPTIONS (whitespace-delimited, breaks on odd paths).
    egressNodeArgs = prep.nodeArgs;
    Object.assign(injectedEnv, prep.env);
  }

  const envEntries = Object.entries(injectedEnv).length
    ? Object.entries(injectedEnv).map(([k, v]) => ["-e", `${k}=${v}`]).flat()
    : [];

  // Sibling mode: binds must reference HOST paths. Container paths under the
  // compose layout start with /app/ — anything else would silently mount a
  // wrong host directory, so refuse instead. A remote daemon (DOCKER_HOST)
  // without host paths cannot map anything at all.
  const remoteDaemon = (process.env.DOCKER_HOST ?? "").trim().startsWith("tcp://");
  if (remoteDaemon && !sibling.enabled) {
    return {
      stdout: "",
      stderr:
        "Error: the docker daemon is remote (DOCKER_HOST) but neither CLAW2_SIBLING_SOURCE_CONTAINER nor CLAW2_SIBLING_HOST_ROOT is set; skill sandbox binds cannot be mapped to host paths (fail-closed)",
      exitCode: -1,
    };
  }
  const mapToHost = (src: string): string | null =>
    sibling.enabled ? mapSandboxPathToHost(src, sibling.mounts, sibling.hostRoot) : src;
  const mountSpecs: Array<{ src: string; dst: string; opts: string }> = [
    { src: agentsDir, dst: "/app/agents", opts: "ro" },
    { src: outputDir, dst: "/app/output", opts: "" },
    ...(options.uploadsDir ? [{ src: options.uploadsDir, dst: "/app/uploads", opts: "ro" }] : []),
  ];
  const volumeMounts: string[] = [];
  for (const m of mountSpecs) {
    const hostSrc = mapToHost(m.src);
    if (hostSrc === null) {
      return {
        stdout: "",
        stderr: `Error: cannot map skill sandbox mount "${m.src}" to a host path (CLAW2_SIBLING_SOURCE_CONTAINER=${siblingSourceContainer()}, CLAW2_SIBLING_HOST_ROOT=${sibling.hostRoot}); refusing to bind a wrong directory`,
        exitCode: -1,
      };
    }
    volumeMounts.push(`${hostSrc}:${m.dst}${m.opts ? ":" + m.opts : ""}`);
  }

  // Unique name: on timeout the container is killed by name — the CLI dying
  // alone would leave an infinite skill running (--rm only cleans up on a
  // normal exit).
  const containerName = `claw2-agent-${randomUUID()}`;
  const memory = config.sandbox?.dockerMemory?.trim() || "512m";
  const pidsLimit = Math.max(1, Math.floor(config.sandbox?.dockerPidsLimit ?? 64));

  const dockerArgs = [
    "run",
    "--rm",
    "-i",
    "--name",
    containerName,
    // Hardening: no capabilities, no privilege escalation, bounded resources,
    // read-only rootfs (skill writes go to the /app/output mount; /tmp is a
    // noexec tmpfs so a skill cannot drop and run a binary).
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--memory",
    memory,
    "--pids-limit",
    String(pidsLimit),
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    ...egressDockerArgs,
    ...volumeMounts.flatMap((v) => ["-v", v]),
    "-w",
    "/app/agents",
    ...envEntries,
    image,
    "node",
    ...egressNodeArgs,
    script,
    ...args,
  ];

  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn("docker", dockerArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    // Cap captured output (mirrors the host sandbox): a looping skill must not
    // inflate gateway memory or the prompt.
    const MAX_CAPTURE_BYTES = 256 * 1024;
    let captured = 0;
    let errCaptured = 0;
    let truncated = false;
    proc.stdout?.on("data", (c: Buffer) => {
      if (captured >= MAX_CAPTURE_BYTES) return;
      const room = MAX_CAPTURE_BYTES - captured;
      captured += c.length;
      chunks.push(c.length > room ? c.subarray(0, room) : c);
      if (captured >= MAX_CAPTURE_BYTES) truncated = true;
    });
    proc.stderr?.on("data", (c: Buffer) => {
      if (errCaptured >= MAX_CAPTURE_BYTES) return;
      const room = MAX_CAPTURE_BYTES - errCaptured;
      errCaptured += c.length;
      errChunks.push(c.length > room ? c.subarray(0, room) : c);
    });

    let settled = false;
    const settle = (result: RunAgentResult) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    const timeout = setTimeout(() => {
      // Kill by name first: `docker run --rm -i` keeps the container running
      // when only the CLI client dies, so SIGKILL to the CLI is not enough
      // for an infinite skill.
      try {
        spawnSync("docker", ["kill", containerName], { timeout: 10_000 });
      } catch {
        /* best effort; fall through to killing the CLI */
      }
      proc.kill("SIGKILL");
      settle({
        stdout:
          Buffer.concat(chunks).toString("utf-8") + (truncated ? "\n[output truncated]\n" : ""),
        stderr: Buffer.concat(errChunks).toString("utf-8") + "\n[timeout]\n",
        exitCode: -1,
      });
    }, timeoutMs);

    if (options.stdin !== undefined) proc.stdin?.end(options.stdin, "utf-8");
    else proc.stdin?.end();

    proc.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        if (err?.code === "ENOENT") {
          resolvePromise({
            stdout: "",
            stderr: dockerUnavailableMessage("docker not found"),
            exitCode: -1,
          });
        } else {
          rejectPromise(err);
        }
      }
    });

    proc.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (settled) return;
      settle({
        stdout: Buffer.concat(chunks).toString("utf-8"),
        stderr: Buffer.concat(errChunks).toString("utf-8"),
        exitCode: code ?? (signal ? -1 : 0),
      });
    });
  });
}
