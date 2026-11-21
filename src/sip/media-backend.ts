// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Resolve SIP RTP media backend: Node (@vexyl.ai/sip) vs optional native sidecar.
 *
 * Binary probe order:
 *   1. CLAW2_SIP_SIDECAR_PATH
 *   2. sip.sidecarPath
 *   3. under state dir (`CLAW2_STATE_DIR` or `~/.claw2`):
 *        sip-media-sidecar           (file)
 *        sip-media-sidecar/run-sidecar.sh
 *        sip-media-sidecar/sip-media-sidecar[.exe]
 *
 * Missing binary never throws: auto|sidecar fall back to node with a logged reason.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Claw2Config, SipMediaBackendMode } from "../config/types.js";

export type SipMediaBackendEffective = "node" | "sidecar";

export type ResolvedSipMediaBackend = {
  /** Requested mode from config/env (default auto). */
  requested: SipMediaBackendMode;
  /** Effective backend used by the runtime. */
  backend: SipMediaBackendEffective;
  /** Absolute or configured path when sidecar was selected or probed. */
  sidecarPath?: string;
  /** Human-readable choice / fallback reason (safe to log). */
  reason: string;
};

function sidecarBinaryName(): string {
  return process.platform === "win32" ? "sip-media-sidecar.exe" : "sip-media-sidecar";
}

/** claw2 home: CLAW2_STATE_DIR, else ~/.claw2 */
export function resolveClaw2StateDir(): string {
  const env = process.env.CLAW2_STATE_DIR?.trim();
  if (env) return env;
  return join(homedir(), ".claw2");
}

function isPresentFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Candidate paths to probe (first existing file wins). */
export function listSipSidecarCandidates(config: Claw2Config): string[] {
  const out: string[] = [];
  const push = (p?: string | null) => {
    const v = p?.trim();
    if (v && !out.includes(v)) out.push(v);
  };

  push(process.env.CLAW2_SIP_SIDECAR_PATH);
  push(config.sip?.sidecarPath);

  const stateDir = resolveClaw2StateDir();
  const name = sidecarBinaryName();
  const dir = join(stateDir, "sip-media-sidecar");
  push(dir); // binary placed directly as ~/.claw2/sip-media-sidecar
  push(join(dir, "run-sidecar.sh"));
  push(join(dir, name));

  return out;
}

export function findSipSidecarBinary(config: Claw2Config): string | undefined {
  for (const p of listSipSidecarCandidates(config)) {
    if (isPresentFile(p)) return p;
  }
  return undefined;
}

export function resolveSipMediaBackendMode(config: Claw2Config): SipMediaBackendMode {
  const env = process.env.CLAW2_SIP_MEDIA_BACKEND?.trim().toLowerCase();
  if (env === "node" || env === "sidecar" || env === "auto") return env;
  const m = config.sip?.mediaBackend;
  if (m === "node" || m === "sidecar" || m === "auto") return m;
  return "auto";
}

/**
 * Resolve effective media backend. Never throws if binary is missing.
 */
export function resolveSipMediaBackend(config: Claw2Config): ResolvedSipMediaBackend {
  const requested = resolveSipMediaBackendMode(config);
  const found = findSipSidecarBinary(config);

  if (requested === "node") {
    return {
      requested,
      backend: "node",
      sidecarPath: found,
      reason: "mediaBackend=node",
    };
  }

  if (requested === "sidecar") {
    if (found) {
      return {
        requested,
        backend: "sidecar",
        sidecarPath: found,
        reason: `mediaBackend=sidecar path=${found}`,
      };
    }
    return {
      requested,
      backend: "node",
      reason: "mediaBackend=sidecar but binary not found in ~/.claw2; fallback to node",
    };
  }

  // auto
  if (found) {
    return {
      requested,
      backend: "sidecar",
      sidecarPath: found,
      reason: `mediaBackend=auto found=${found}`,
    };
  }
  return {
    requested,
    backend: "node",
    reason: "mediaBackend=auto; no sidecar in ~/.claw2, using node",
  };
}
