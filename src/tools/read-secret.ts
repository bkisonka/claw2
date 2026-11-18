/**
 * Access to secrets via allowlist (step 4). Only identifiers from secrets.allowlist.
 * Environment variables are supported: id = variable name (for example OPENAI_API_KEY).
 */
import type { Claw2Config } from "../config/types.js";
import { auditLog } from "../audit/log.js";

export function toolReadSecret(
  config: Claw2Config,
  id: string
): { ok: boolean; value?: string; error?: string } {
  const trimmed = String(id ?? "").trim();
  if (!trimmed) return { ok: false, error: "id required" };
  const allowlist = config.secrets?.allowlist ?? [];
  if (allowlist.length === 0) return { ok: false, error: "secrets.allowlist not configured" };
  if (!allowlist.includes(trimmed)) {
    auditLog(config, { type: "secret_denied", details: { id: trimmed } });
    return { ok: false, error: "id not in secrets.allowlist" };
  }
  const value = process.env[trimmed];
  if (value === undefined) return { ok: false, error: "env var not set" };
  auditLog(config, { type: "secret_access", details: { id: trimmed } });
  return { ok: true, value };
}
