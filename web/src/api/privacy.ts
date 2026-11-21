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

export type PrivacyCustomRule = {
  id: string;
  name: string;
  ruleType: "keyword" | "regex";
  pattern: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  enabled?: boolean;
  sortOrder?: number;
};

export type MaskPreviewResult = {
  masked: string;
  tokenCount: number;
  wouldApply: boolean;
  reason: string;
  localEndpoint: boolean;
};

export async function previewPrivacyMask(body: {
  text: string;
  enabled?: boolean;
  applyToLocal?: boolean;
  customRules?: PrivacyCustomRule[];
}): Promise<MaskPreviewResult> {
  const res = await fetch(`${apiBase}/api/privacy/mask-preview`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  return (await res.json()) as MaskPreviewResult;
}

export type PrivacySidecarStatus = {
  found: boolean;
  path: string | null;
  multimodalBackend: "auto" | "off" | "sidecar";
  useSidecar: boolean;
  reason: string;
};

export async function fetchPrivacySidecarStatus(): Promise<PrivacySidecarStatus> {
  const res = await fetch(`${apiBase}/api/privacy/sidecar-status`, {
    method: "GET",
    headers: headers(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  return (await res.json()) as PrivacySidecarStatus;
}
