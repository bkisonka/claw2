// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ensureRemoteAccessDirs, statusPath } from "./paths.js";

export interface RemoteAccessStatusFile {
  ddns?: {
    lastOkAt?: number;
    lastErrorAt?: number;
    lastError?: string;
    lastIp?: string;
    fqdn?: string;
  };
  cert?: {
    lastOkAt?: number;
    lastErrorAt?: number;
    lastError?: string;
    fqdn?: string;
    expiresAt?: number;
    issuer?: string;
    staging?: boolean;
  };
  https?: {
    listening?: boolean;
    port?: number;
    url?: string;
    fqdn?: string;
    openedAt?: number;
    closedAt?: number;
    lastError?: string;
    lastErrorAt?: number;
  };
  upnp?: {
    enabled?: boolean;
    mapped?: boolean;
    externalIp?: string;
    localIp?: string;
    externalPort?: number;
    internalPort?: number;
    lastOkAt?: number;
    lastError?: string;
    lastErrorAt?: number;
  };
}

export function readRemoteAccessStatus(): RemoteAccessStatusFile {
  const p = statusPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as RemoteAccessStatusFile;
  } catch {
    return {};
  }
}

export function writeRemoteAccessStatus(patch: RemoteAccessStatusFile): RemoteAccessStatusFile {
  ensureRemoteAccessDirs();
  const prev = readRemoteAccessStatus();
  const next: RemoteAccessStatusFile = {
    ddns: { ...prev.ddns, ...patch.ddns },
    cert: { ...prev.cert, ...patch.cert },
    https: { ...prev.https, ...patch.https },
    upnp: { ...prev.upnp, ...patch.upnp },
  };
  writeFileSync(statusPath(), JSON.stringify(next, null, 2), "utf-8");
  return next;
}
