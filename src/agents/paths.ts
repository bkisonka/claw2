// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Single resolution of the agents/output/uploads directory.
 * Desktop/CLAW2_STATE_DIR: Defaults to ~/.claw2/agents (not application cwd).
 */
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Claw2Config } from "../config/types.js";
import { defaultAgentsDirUnderState, usesHomeStateLayout } from "../config/state-dir.js";

export function resolveAgentsDir(config: Claw2Config): string {
  if (config.agentsDir?.trim()) return resolve(config.agentsDir.trim());
  if (usesHomeStateLayout()) return defaultAgentsDirUnderState();
  return resolve(process.cwd(), "agents");
}

export function resolveAgentsOutputDir(config: Claw2Config): string {
  return resolve(resolveAgentsDir(config), "output");
}

export function resolveAgentsUploadsDir(config: Claw2Config): string {
  const host = config.uploads?.hostPath?.trim();
  if (host) return resolve(host);
  return resolve(resolveAgentsDir(config), "uploads");
}

/** Legacy cwd/agents - files saved before moving to STATE_DIR.*/
export function resolveLegacyAgentsDir(): string {
  return resolve(process.cwd(), "agents");
}

/**
 * Absolute path to the file under agents (output|uploads/…).
 * First current agentsDir, then legacy cwd/agents.
 * null — path outside the root; when allowMissing without a file - primary path.
 */
export function resolveAgentsFilePath(
  agentsDir: string,
  rel: string,
  opts?: { allowMissing?: boolean }
): string | null {
  const safeRel = rel.replace(/^\/+/, "").replace(/\.\./g, "");
  if (!safeRel) return null;

  const candidate = (root: string): string | null => {
    const full = resolve(root, safeRel);
    const fromRoot = relative(root, full);
    if (fromRoot.startsWith("..") || fromRoot === "") return null;
    return full;
  };

  const primary = candidate(agentsDir);
  if (primary && existsSync(primary)) return primary;

  const legacyRoot = resolveLegacyAgentsDir();
  if (resolve(legacyRoot) !== resolve(agentsDir)) {
    const legacy = candidate(legacyRoot);
    if (legacy && existsSync(legacy)) return legacy;
  }

  if (opts?.allowMissing && primary) return primary;
  return null;
}
