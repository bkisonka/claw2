// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * message tool: send to one webhook from allowlist (one recipient per call).
 */
import type { Claw2Config } from "../config/types.js";

export async function toolMessage(
  config: Claw2Config,
  webhookUrl: string,
  body: string
): Promise<{ ok: boolean; error?: string }> {
  if (!webhookUrl || typeof webhookUrl !== "string") return { ok: false, error: "webhookUrl required" };
  const url = webhookUrl.trim();
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return { ok: false, error: "only http and https webhooks allowed" };
  }
  const allowed = config.tools?.message?.allowedWebhooks ?? [];
  if (allowed.length === 0) return { ok: false, error: "no webhooks in tools.message.allowedWebhooks" };
  if (!allowed.includes(url)) return { ok: false, error: "webhook URL not in allowedWebhooks" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: body }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
