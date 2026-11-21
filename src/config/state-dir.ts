// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * claw2 state directory: CLAW2_STATE_DIR or ~/.claw2 (desktop),
 * otherwise cwd/.claw2 (dev CLI without STATE_DIR).
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

export function getClaw2StateDir(): string {
  const fromEnv = process.env.CLAW2_STATE_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  if (process.env.CLAW2_DESKTOP === "1") {
    return resolve(homedir(), ".claw2");
  }
  return resolve(process.cwd(), ".claw2");
}

/** true when desktop or explicit state dir — data lives under state, not next to the binary. */
export function usesHomeStateLayout(): boolean {
  return process.env.CLAW2_DESKTOP === "1" || !!process.env.CLAW2_STATE_DIR?.trim();
}

export function defaultAgentsDirUnderState(): string {
  return resolve(getClaw2StateDir(), "agents");
}

export function defaultUploadsDirUnderState(): string {
  return resolve(defaultAgentsDirUnderState(), "uploads");
}

export function defaultOutputDirUnderState(): string {
  return resolve(defaultAgentsDirUnderState(), "output");
}
