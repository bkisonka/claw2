// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { Claw2Config } from "../../config/types.js";
import { findPrivacyOcrSidecarBinary } from "./find-binary.js";

export function defaultPrivacyOcrIpcPath(): string {
  const fromEnv =
    process.env.CLAW2_PRIVACY_OCR_IPC?.trim() || process.env.PRIVACY_OCR_IPC_PATH?.trim();
  if (fromEnv) return fromEnv;
  if (process.platform === "win32") return "\\\\.\\pipe\\claw2-privacy-ocr";
  return join(tmpdir(), "privacy-ocr-sidecar.sock");
}

export type SpawnPrivacyOcrResult = {
  proc: ChildProcess;
  ipcPath: string;
  binary: string;
  logPath: string;
};

export function spawnPrivacyOcrSidecar(
  config: Claw2Config,
  opts?: { ipcPath?: string }
): SpawnPrivacyOcrResult {
  const binary = findPrivacyOcrSidecarBinary(config);
  if (!binary) {
    throw new Error("privacy-ocr-sidecar binary not found");
  }
  const ipcPath = opts?.ipcPath || defaultPrivacyOcrIpcPath();
  // Unix socket file only — named pipes on Windows must not be unlinked as files.
  if (process.platform !== "win32") {
    try {
      unlinkSync(ipcPath);
    } catch {
      /* */
    }
  }
  const stateRoot = process.env.CLAW2_STATE_DIR?.trim() || join(homedir(), ".claw2");
  const workDir = join(stateRoot, "privacy-ocr-sidecar");
  mkdirSync(workDir, { recursive: true });
  const logPath = join(workDir, "sidecar.log");
  const logFd = createWriteStream(logPath, { flags: "a" });
  // Tesseract expects TESSDATA_PREFIX = parent of the tessdata/ directory.
  const tessBeside = join(workDir, "tessdata");
  const tessNearBin = join(binary, "..", "tessdata");
  const tessPrefix =
    process.env.TESSDATA_PREFIX?.trim() ||
    (existsSync(tessBeside) ? workDir : existsSync(tessNearBin) ? join(binary, "..") : undefined);
  const proc = spawn(binary, [ipcPath], {
    env: {
      ...process.env,
      PRIVACY_OCR_IPC_PATH: ipcPath,
      CLAW2_PRIVACY_OCR_IPC: ipcPath,
      ...(tessPrefix ? { TESSDATA_PREFIX: tessPrefix } : {}),
    },
    cwd: workDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.pipe(logFd);
  proc.stderr?.pipe(logFd);
  return { proc, ipcPath, binary, logPath };
}

export async function stopPrivacyOcrProcess(proc: ChildProcess | null): Promise<void> {
  if (!proc || proc.exitCode != null || proc.signalCode != null) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    /* */
  }
  await new Promise<void>((r) => {
    const t = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* */
      }
      r();
    }, 1500);
    proc.once("exit", () => {
      clearTimeout(t);
      r();
    });
  });
}
