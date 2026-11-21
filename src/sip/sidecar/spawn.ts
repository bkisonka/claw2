// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Spawn sip-media-sidecar process (platform binary from findSipSidecarBinary).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Claw2Config } from "../../config/types.js";
import {
  resolveSipDomain,
  resolveSipLocalPort,
  resolveSipPassword,
  resolveSipPublicAddress,
  resolveSipServer,
  resolveSipUser,
} from "../../config/sip.js";
import { findSipSidecarBinary } from "../media-backend.js";

export type SpawnSidecarResult = {
  proc: ChildProcess;
  ipcPath: string;
  binary: string;
  logPath: string;
};

export function defaultSidecarIpcPath(): string {
  return (
    process.env.CLAW2_SIP_SIDECAR_IPC?.trim() ||
    process.env.SIDECAR_IPC_PATH?.trim() ||
    "/tmp/sip-media-sidecar.sock"
  );
}

export function resolveSidecarWorkDir(config: Claw2Config): string {
  const env = process.env.CLAW2_SIP_SIDECAR_WORKDIR?.trim();
  if (env) return env;
  return join(process.cwd(), ".claw2", "sip-sidecar");
}

/**
 * Spawn sidecar with SIP env from claw2 config. Caller owns lifecycle.
 * Binary must exist (see findSipSidecarBinary).
 */
export function spawnSipSidecar(config: Claw2Config, opts?: { ipcPath?: string }): SpawnSidecarResult {
  const binary = findSipSidecarBinary(config);
  if (!binary) {
    throw new Error(
      "sip-media-sidecar binary not found (put it in ~/.claw2/sip-media-sidecar/ or set sip.sidecarPath). " +
        "See sip-media-sidecar/README.md"
    );
  }

  const ipcPath = opts?.ipcPath || defaultSidecarIpcPath();
  try {
    unlinkSync(ipcPath);
  } catch {
    /* ignore */
  }

  const workDir = resolveSidecarWorkDir(config);
  mkdirSync(workDir, { recursive: true });
  const logPath = join(workDir, "sidecar.log");
  const logFd = createWriteStream(logPath, { flags: "a" });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SIDECAR_IPC_PATH: ipcPath,
    SIP_SERVER: resolveSipServer(config),
    SIP_USER: resolveSipUser(config),
    SIP_PASSWORD: resolveSipPassword(config),
    SIP_DOMAIN: resolveSipDomain(config),
    SIP_LOCAL_PORT: String(resolveSipLocalPort(config)),
    SIP_SAMPLE_RATE: "8000",
    SIP_PLAY_PREBUFFER_MS: process.env.SIP_PLAY_PREBUFFER_MS?.trim() || "280",
  };
  const pub = resolveSipPublicAddress(config);
  if (pub) env.SIP_PUBLIC_ADDR = pub;

  const proc = spawn(binary, [ipcPath], {
    env,
    cwd: workDir,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  proc.stdout?.pipe(logFd);
  proc.stderr?.pipe(logFd);
  proc.on("error", (err) => {
    console.error("[sip/sidecar] spawn error:", err);
  });

  console.error(`[sip/sidecar] spawned pid=${proc.pid} bin=${binary} ipc=${ipcPath} log=${logPath}`);
  return { proc, ipcPath, binary, logPath };
}

export async function stopSipSidecarProcess(proc: ChildProcess | null): Promise<void> {
  if (!proc || proc.exitCode != null || proc.signalCode != null) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve();
    }, 5_000);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

export function ensureIpcParentDir(ipcPath: string): void {
  try {
    mkdirSync(dirname(ipcPath), { recursive: true });
  } catch {
    /* ignore for /tmp */
  }
}
