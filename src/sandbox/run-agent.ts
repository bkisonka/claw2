/**
 * Run the agent script in Docker-sandbox or on the host (useDocker: false).
 * Default policy: write only to agents/output (in the container - /app/output).
 * On the host - Node --permission; optional sandbox.hostFs (allowlist | full).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve, relative } from "node:path";
import type { Claw2Config } from "../config/types.js";

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
export function runAgentHost(
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
    return Promise.resolve({
      stdout: "",
      stderr:
        `Error: Node --permission is required for host sandbox, but this Node build does not support it (${nodeBin}). Use Docker (sandbox.useDocker: true), set CLAW2_NODE_BIN to Node 20+, or upgrade Node.`,
      exitCode: -1,
    });
  }

  return new Promise((resolvePromise, rejectPromise) => {
    // --no-addons closes the permission-model bypass via native modules: without
    // it a skill could require(".node") addons and escape the fs/network regime.
    const proc = spawn(nodeBin, [...perm, "--no-addons", script, ...args], {
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
  const envEntries = Object.entries(injectedEnv).length
    ? Object.entries(injectedEnv).map(([k, v]) => ["-e", `${k}=${v}`]).flat()
    : [];

  const volumeMounts = [`${agentsDir}:/app/agents:ro`, `${outputDir}:/app/output`];
  if (options.uploadsDir) {
    volumeMounts.push(`${options.uploadsDir}:/app/uploads:ro`);
  }

  const dockerArgs = [
    "run",
    "--rm",
    "-i",
    ...volumeMounts.flatMap((v) => ["-v", v]),
    "-w",
    "/app/agents",
    ...envEntries,
    image,
    "node",
    script,
    ...args,
  ];

  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn("docker", dockerArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout?.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr?.on("data", (c: Buffer) => errChunks.push(c));

    let settled = false;
    const settle = (result: RunAgentResult) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      settle({
        stdout: Buffer.concat(chunks).toString("utf-8"),
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
