// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { apiBase, apiKey } from "../config";
import { getAuthHeaders } from "../auth/storage";

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", ...getAuthHeaders() };
  if (apiKey) {
    h["X-API-Key"] = apiKey;
    if (!h["Authorization"]) h["Authorization"] = `Bearer ${apiKey}`;
  }
  return h;
}

export interface UpdateCheck {
  current: string;
  latest: string | null;
  available: boolean;
  releaseUrl: string | null;
  fetchedAt: number;
  error?: string;
  checksDisabled?: boolean;
  /** A host-side update watcher (scripts/update.sh --watch) is connected. */
  autoUpdate?: boolean;
}

export interface UpdateProgress {
  step: string;
  percent: number;
  message?: string;
  done?: boolean;
  error?: boolean;
  startedAt: number;
  updatedAt: number;
}

export interface UpdateStatus {
  progress: UpdateProgress | null;
  autoUpdate: boolean;
  requested: boolean;
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json().catch(() => ({}))) as T;
}

export async function checkUpdate(): Promise<UpdateCheck | null> {
  try {
    const res = await fetch(`${apiBase}/api/update/check`, { headers: headers(), cache: "no-store" });
    if (!res.ok) return null;
    return await json<UpdateCheck>(res);
  } catch {
    return null;
  }
}

export async function fetchUpdateStatus(): Promise<UpdateStatus | null> {
  try {
    const res = await fetch(`${apiBase}/api/update/status`, { headers: headers(), cache: "no-store" });
    if (!res.ok) return null;
    return await json<UpdateStatus>(res);
  } catch {
    return null; // gateway restarting — the dialog treats this as a phase
  }
}

export async function requestUpdate(): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase}/api/update/request`, { method: "POST", headers: headers() });
    return res.ok;
  } catch {
    return false;
  }
}
