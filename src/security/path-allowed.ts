// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Check paths for read/write/edit tools.
 * Only paths within the workspace or in allowlist.paths are allowed.
 * Prohibited: .env, .env.*, .ssh, etc.
 */
import { resolve, relative, normalize } from "node:path";
import type { Claw2Config } from "../config/types.js";

const FORBIDDEN_SEGMENTS = [".env", ".ssh", "secret", "secrets"];
const FORBIDDEN_PREFIXES = [".env", ".env."];

function isForbiddenPath(resolvedPath: string): boolean {
  const normalized = normalize(resolvedPath);
  const parts = normalized.split(/[/\\]/).filter(Boolean);
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (FORBIDDEN_SEGMENTS.some((s) => lower === s || lower.startsWith(s + "."))) return true;
    if (FORBIDDEN_PREFIXES.some((p) => lower.startsWith(p))) return true;
  }
  if (normalized.includes(".ssh") || normalized.includes(".env")) return true;
  return false;
}

function isUnderBase(absolutePath: string, baseDir: string): boolean {
  const base = resolve(baseDir);
  const path = resolve(absolutePath);
  const rel = relative(base, path);
  return (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/")));
}

/** Substituting the uploads alias to the path from the config (hostPath).*/
function resolveUploadsAlias(pathArg: string, config: Claw2Config): string {
  const t = pathArg.trim();
  const hostPath = config.uploads?.hostPath ?? "agents/uploads";
  if (t === "uploads" || t === "uploads/") return hostPath;
  if (t.startsWith("uploads/")) return `${hostPath.replace(/\/+$/, "")}/${t.slice(8)}`;
  return t;
}

/** Substitution of the output alias to agents/output (for list_dir/read, etc.).*/
function resolveOutputAlias(pathArg: string, config: Claw2Config): string {
  const t = pathArg.trim();
  const outputPath = `${config.agentsDir ?? "agents"}/output`;
  if (t === "output" || t === "output/") return outputPath;
  if (t.startsWith("output/")) return `${outputPath}/${t.slice(7).replace(/^\/+/, "")}`;
  return t;
}

/** Alias ​​uploads and output for paths. Export for fs-tools.*/
export function resolvePathAliases(pathArg: string, config: Claw2Config): string {
  return resolveOutputAlias(resolveUploadsAlias(pathArg, config), config);
}

/**
 * In the agents/ directory, the following are allowed: the directory itself (list_dir), direct files (agents/script.js)
 * and any paths in agents/uploads, agents/output.
 * Nested directories like agents/foo/bar.js are prohibited - the model creates them, but read/list_dir/run_agent is not compatible with them.
 */
function isAllowedUnderAgents(resolvedPath: string, config: Claw2Config): boolean {
  const agentsDir = resolve(process.cwd(), config.agentsDir ?? "agents");
  if (!isUnderBase(resolvedPath, agentsDir)) return true;
  const rel = relative(agentsDir, resolve(resolvedPath)).replace(/\\/g, "/");
  if (rel.startsWith("..")) return false;
  if (rel === "") return true; // list_dir(agents)
  if (!rel.includes("/")) return true; // direct child: agents/script.js
  const first = rel.split("/")[0]?.toLowerCase() ?? "";
  return first === "uploads" || first === "output";
}

/**
 * Checks if the path is allowed for read/write/edit/list_dir operations.
 * Allowed: agents/ (root + *.js), agents/uploads, agents/output; plus allowlist.paths.
 */
export function isPathAllowed(pathArg: string, config: Claw2Config): boolean {
  if (!pathArg || typeof pathArg !== "string") return false;
  const trimmed = resolvePathAliases(pathArg, config);
  if (!trimmed) return false;

  const workspaceDir = config.workspace ? resolve(config.workspace) : resolve(process.cwd());
  const resolvedPath = trimmed.startsWith("/") ? resolve(trimmed) : resolve(workspaceDir, trimmed);

  if (isForbiddenPath(resolvedPath)) return false;

  const agentsBase = resolve(process.cwd(), config.agentsDir ?? "agents");
  const uploadsBase = resolve(process.cwd(), config.uploads?.hostPath ?? "agents/uploads");
  const outputBase = resolve(process.cwd(), config.agentsDir ?? "agents", "output");

  // Desktop / default: agents scripts + uploads/output always readable (list_dir / read),
  // without requiring allowlist.paths — otherwise the model cannot discover scripts.
  if (isUnderBase(resolvedPath, agentsBase) && isAllowedUnderAgents(resolvedPath, config)) {
    return true;
  }
  if (isUnderBase(resolvedPath, uploadsBase) || isUnderBase(resolvedPath, outputBase)) {
    return true;
  }

  const allowlistPaths = config.allowlist?.paths ?? [];
  for (const allowed of allowlistPaths) {
    const base = allowed.startsWith("/") ? resolve(allowed) : resolve(process.cwd(), allowed);
    if (isUnderBase(resolvedPath, base)) {
      if (!isAllowedUnderAgents(resolvedPath, config)) return false;
      return true;
    }
  }

  return false;
}

/**
 * The path is in uploads or in agents/output - the content cannot be transferred outside (message, etc.).
 */
export function isPathUploadsOrOutput(pathArg: string, config: Claw2Config): boolean {
  if (!pathArg || typeof pathArg !== "string") return false;
  const trimmed = resolvePathAliases(pathArg, config);
  if (!trimmed) return false;
  const workspaceDir = config.workspace ? resolve(config.workspace) : resolve(process.cwd());
  const resolvedPath = trimmed.startsWith("/") ? resolve(trimmed) : resolve(workspaceDir, trimmed);
  const uploadsBase = resolve(process.cwd(), config.uploads?.hostPath ?? "agents/uploads");
  const outputBase = resolve(process.cwd(), config.agentsDir ?? "agents", "output");
  return isUnderBase(resolvedPath, uploadsBase) || isUnderBase(resolvedPath, outputBase);
}
