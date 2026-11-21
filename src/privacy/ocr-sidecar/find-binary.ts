// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Claw2Config } from "../../config/types.js";

function isPresentFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

function platformTriple(): string {
  const p = process.platform;
  const a = process.arch;
  if (p === "darwin") return a === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (p === "linux") return a === "arm64" ? "linux-arm64" : "linux-x64";
  if (p === "win32") return a === "arm64" ? "win32-arm64" : "win32-x64";
  return `${p}-${a}`;
}

export function listPrivacyOcrSidecarCandidates(config: Claw2Config): string[] {
  const name = process.platform === "win32" ? "privacy-ocr-sidecar.exe" : "privacy-ocr-sidecar";
  const stateRoot = process.env.CLAW2_STATE_DIR?.trim() || join(homedir(), ".claw2");
  const triple = platformTriple();
  const out: string[] = [];

  const cfgPath = config.privacy?.ocrSidecarPath?.trim();
  if (cfgPath) out.push(cfgPath);
  const envPath = process.env.CLAW2_PRIVACY_OCR_SIDECAR_PATH?.trim();
  if (envPath) out.push(envPath);

  out.push(join(stateRoot, "privacy-ocr-sidecar", name));
  out.push(join(stateRoot, "privacy-ocr-sidecar", name.replace(/\.exe$/, "")));

  const resources = process.env.CLAW2_RESOURCES_PATH?.trim() || (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resources) {
    out.push(join(resources, "privacy-ocr-sidecar", triple, name));
    out.push(join(resources, "privacy-ocr-sidecar", name));
  }

  // Dev tree
  const cwd = process.cwd();
  out.push(join(cwd, "privacy-ocr-sidecar", "bin", triple, name));
  out.push(join(cwd, "privacy-ocr-sidecar", "dist", name));
  out.push(join(cwd, "desktop", "vendor", "privacy-ocr-sidecar", triple, name));

  return [...new Set(out.filter(Boolean))];
}

export function findPrivacyOcrSidecarBinary(config: Claw2Config): string | undefined {
  for (const p of listPrivacyOcrSidecarCandidates(config)) {
    if (isPresentFile(p)) return p;
  }
  return undefined;
}

export type MultimodalBackendMode = "auto" | "off" | "sidecar";

export function resolveMultimodalBackendMode(config: Claw2Config): MultimodalBackendMode {
  const env = process.env.CLAW2_PRIVACY_MULTIMODAL_BACKEND?.trim().toLowerCase();
  if (env === "auto" || env === "off" || env === "sidecar") return env;
  const m = config.privacy?.multimodalBackend;
  if (m === "auto" || m === "off" || m === "sidecar") return m;
  return "auto";
}

export type ResolvedMultimodalBackend = {
  requested: MultimodalBackendMode;
  /** Use sidecar process */
  useSidecar: boolean;
  /** Block multimodal when privacy on and no sidecar */
  blockWithoutSidecar: boolean;
  sidecarPath?: string;
  reason: string;
};

export function resolveMultimodalBackend(config: Claw2Config): ResolvedMultimodalBackend {
  const requested = resolveMultimodalBackendMode(config);
  const found = findPrivacyOcrSidecarBinary(config);
  if (requested === "off") {
    return {
      requested,
      useSidecar: false,
      blockWithoutSidecar: false,
      sidecarPath: found,
      reason: "multimodalBackend=off",
    };
  }
  if (requested === "sidecar") {
    return {
      requested,
      useSidecar: !!found,
      blockWithoutSidecar: true,
      sidecarPath: found,
      reason: found ? `sidecar path=${found}` : "sidecar required but binary missing",
    };
  }
  // auto
  return {
    requested,
    useSidecar: !!found,
    blockWithoutSidecar: true,
    sidecarPath: found,
    reason: found ? `auto found=${found}` : "auto; no sidecar — block multimodal",
  };
}
