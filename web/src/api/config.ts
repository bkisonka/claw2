// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { apiBase, apiKey } from "../config";
import { getAuthHeaders } from "../auth/storage";
import { t } from "../i18n";

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", ...getAuthHeaders() };
  if (apiKey) {
    h["X-API-Key"] = apiKey;
    if (!h["Authorization"]) h["Authorization"] = `Bearer ${apiKey}`;
  }
  return h;
}

export type Config = Record<string, unknown>;

/** GET /api/config response may include a diagnostic _source: "db" | "file" field. */
export async function getConfig(): Promise<Config> {
  const res = await fetch(`${apiBase}/api/config`, { headers: headers() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  const raw = (await res.json()) as Record<string, unknown>;
  const { _source: _drop, ...config } = raw;
  return config as Config;
}

export async function putConfig(
  config: Config
): Promise<{ ok: boolean; message?: string; configPath?: string; _source?: "db" | "file" }> {
  const res = await fetch(`${apiBase}/api/config`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify(config),
  });
  const raw = await res.text();
  let data: { ok?: boolean; message?: string; error?: string; configPath?: string; _source?: "db" | "file" };
  try {
    data = (raw ? JSON.parse(raw) : {}) as typeof data;
  } catch {
    throw new Error(res.ok ? t("api.configNotJson") : `HTTP ${res.status}: ${raw.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return { ok: !!data.ok, message: data.message, configPath: data.configPath, _source: data._source };
}
