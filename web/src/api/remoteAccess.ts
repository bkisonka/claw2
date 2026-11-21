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

export interface RemoteAccessStatus {
  provider: "duckdns";
  ddnsEnabled: boolean;
  tlsEnabled: boolean;
  listenEnabled?: boolean;
  openOnTrayHide?: boolean;
  listenPort?: number;
  domainConfigured: boolean;
  fqdn?: string;
  staging?: boolean;
  ddns: {
    lastOkAt?: number;
    lastErrorAt?: number;
    lastError?: string;
    lastIp?: string;
    fqdn?: string;
  };
  cert: {
    lastOkAt?: number;
    lastErrorAt?: number;
    lastError?: string;
    fqdn?: string;
    expiresAt?: number;
    issuer?: string;
    staging?: boolean;
    hasCert?: boolean;
    fullchainPath?: string;
    privkeyPath?: string;
  };
  https?: {
    listening?: boolean;
    port?: number;
    url?: string;
    lastError?: string;
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
  busy: { ddns: boolean; cert: boolean };
  note?: string;
}

export async function fetchRemoteAccessStatus(): Promise<RemoteAccessStatus> {
  const res = await fetch(`${apiBase}/api/remote-access/status`, { headers: headers() });
  const data = (await res.json().catch(() => ({}))) as RemoteAccessStatus & { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function updateRemoteAccessDdns(): Promise<{
  ok: boolean;
  fqdn?: string;
  ip?: string;
  error?: string;
}> {
  const res = await fetch(`${apiBase}/api/remote-access/ddns/update`, {
    method: "POST",
    headers: headers(),
  });
  return (await res.json().catch(() => ({}))) as {
    ok: boolean;
    fqdn?: string;
    ip?: string;
    error?: string;
  };
}

export async function issueRemoteAccessCert(): Promise<{
  ok: boolean;
  fqdn?: string;
  fullchainPath?: string;
  privkeyPath?: string;
  expiresAt?: number;
  error?: string;
}> {
  const res = await fetch(`${apiBase}/api/remote-access/cert/issue`, {
    method: "POST",
    headers: headers(),
  });
  return (await res.json().catch(() => ({}))) as {
    ok: boolean;
    fqdn?: string;
    fullchainPath?: string;
    privkeyPath?: string;
    expiresAt?: number;
    error?: string;
  };
}

export async function openRemoteHttps(): Promise<{ ok: boolean; url?: string; error?: string }> {
  const res = await fetch(`${apiBase}/api/remote-access/https/open`, {
    method: "POST",
    headers: headers(),
  });
  return (await res.json().catch(() => ({}))) as { ok: boolean; url?: string; error?: string };
}

export async function closeRemoteHttps(): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${apiBase}/api/remote-access/https/close`, {
    method: "POST",
    headers: headers(),
  });
  return (await res.json().catch(() => ({}))) as { ok: boolean; error?: string };
}
