// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Security audit: configuration checks (sandbox, Content Boundary, memory, paths, auth, skills).
 */
import type { Claw2Config } from "../config/types.js";

export type AuditLevel = "ok" | "warning" | "error";

export interface AuditItem {
  level: AuditLevel;
  category: string;
  message: string;
  recommendation?: string;
}

export function runAudit(config: Claw2Config): AuditItem[] {
  const items: AuditItem[] = [];

  // Sandbox: by default used for run_agent (always in the code), we check that the image is specified
  if (!config.sandbox?.image) {
    items.push({
      level: "warning",
      category: "sandbox",
      message: "sandbox.image not set",
      recommendation: "Set sandbox.image (e.g. node:20-alpine) for agent execution.",
    });
  } else {
    items.push({ level: "ok", category: "sandbox", message: "sandbox.image is set" });
  }

  // Content Boundary: in the code, all channels (cli, webchat, telegram) go through wrapExternalContent
  items.push({
    level: "ok",
    category: "content-boundary",
    message: "Incoming channels use Content Boundary (code convention).",
  });

  // Memory: limits and sanitization
  if (config.memory?.enabled) {
    if (config.memory.maxChunks == null || config.memory.maxRecallChunks == null) {
      items.push({
        level: "warning",
        category: "memory",
        message: "memory enabled but maxChunks or maxRecallChunks not set",
        recommendation: "Set memory.maxChunks and memory.maxRecallChunks in config.",
      });
    } else {
      items.push({
        level: "ok",
        category: "memory",
        message: `memory enabled, maxChunks=${config.memory.maxChunks}, maxRecallChunks=${config.memory.maxRecallChunks}`,
      });
    }
  } else {
    items.push({ level: "ok", category: "memory", message: "memory disabled (optional)" });
  }

  // Workspace and path allowlist
  if (!config.workspace) {
    items.push({
      level: "warning",
      category: "paths",
      message: "workspace not set, using process.cwd()",
      recommendation: "Set workspace in config for predictable read/write/edit scope.",
    });
  } else {
    items.push({ level: "ok", category: "paths", message: `workspace set: ${config.workspace}` });
  }
  const allowlistPaths = config.allowlist?.paths ?? [];
  const forbiddenInAllowlist = allowlistPaths.some(
    (p) => /\.env|\.ssh|secret/i.test(p)
  );
  if (forbiddenInAllowlist) {
    items.push({
      level: "error",
      category: "paths",
      message: "allowlist.paths contains path that looks like .env, .ssh or secret",
      recommendation: "Remove sensitive paths from allowlist.paths.",
    });
  } else if (allowlistPaths.length > 0) {
    items.push({ level: "ok", category: "paths", message: `allowlist.paths has ${allowlistPaths.length} entries, no obvious forbidden names` });
  }

  // Skills: if there is a section, allowlist must be specified
  if (config.skills) {
    const list = config.skills.allowlist ?? [];
    if (list.length === 0) {
      items.push({
        level: "warning",
        category: "skills",
        message: "skills section present but allowlist empty",
        recommendation: "Add skills.allowlist with allowed skill ids or remove skills section.",
      });
    } else {
      items.push({ level: "ok", category: "skills", message: `skills.allowlist has ${list.length} entries` });
    }
  }

  // Gateway auth
  if (config.gateway?.auth?.enabled) {
    const apiKey = config.gateway.auth.apiKey ?? "";
    if (!apiKey || apiKey.length < 8) {
      items.push({
        level: "error",
        category: "gateway",
        message: "gateway.auth.enabled but apiKey missing or too short",
        recommendation: "Set gateway.auth.apiKey or use env:VAR reference.",
      });
    } else {
      items.push({ level: "ok", category: "gateway", message: "gateway auth enabled, apiKey set" });
    }
  } else {
    items.push({
      level: "warning",
      category: "gateway",
      message: "gateway auth disabled",
      recommendation: "Enable gateway.auth and set apiKey if gateway is exposed.",
    });
  }

  // Audit log (stage 4)
  if (config.audit?.logPath) {
    items.push({ level: "ok", category: "audit", message: `audit.logPath set: ${config.audit.logPath}` });
  } else {
    items.push({
      level: "warning",
      category: "audit",
      message: "audit.logPath not set, audit log disabled",
      recommendation: "Set audit.logPath to log security events (memory_denied, lethal_trifecta, elevated_use, secret_access, file_read, file_write, file_edit).",
    });
  }

  // Lethal Trifecta (Stage 4)
  if (config.security?.lethalTrifecta?.enabled) {
    items.push({
      level: "ok",
      category: "security",
      message: `lethalTrifecta enabled, action=${config.security.lethalTrifecta.action ?? "warn"}`,
    });
  }

  // Message policy (stage 4)
  const msgPolicy = config.tools?.message?.policy ?? "allow_one";
  items.push({ level: "ok", category: "message-policy", message: `tools.message.policy: ${msgPolicy}` });

  // Elevated (stage 4)
  if (config.sandbox?.elevatedAllowed) {
    items.push({
      level: "warning",
      category: "sandbox",
      message: "sandbox.elevatedAllowed is true",
      recommendation: "Only enable for trusted sessions; elevated runs agents on host.",
    });
  }

  const hostFsMode = config.sandbox?.hostFs?.mode ?? "default";
  if (hostFsMode === "full") {
    items.push({
      level: "warning",
      category: "sandbox",
      message: "sandbox.hostFs.mode is full (agents can read/write entire host FS)",
      recommendation: "Prefer hostFs.mode: allowlist with explicit paths, or leave default.",
    });
  } else if (hostFsMode === "allowlist") {
    const n =
      (config.sandbox?.hostFs?.read?.length ?? 0) + (config.sandbox?.hostFs?.write?.length ?? 0);
    items.push({
      level: "ok",
      category: "sandbox",
      message: `sandbox.hostFs.mode=allowlist (${n} extra path(s))`,
    });
  }

  // Secrets (stage 4)
  if (config.secrets?.allowlist && config.secrets.allowlist.length > 0) {
    items.push({ level: "ok", category: "secrets", message: `secrets.allowlist has ${config.secrets.allowlist.length} entries` });
  }

  return items;
}

export function formatAuditReport(items: AuditItem[], format: "text" | "json" = "text"): string {
  if (format === "json") {
    return JSON.stringify({ items }, null, 2);
  }
  const byCategory = new Map<string, AuditItem[]>();
  for (const item of items) {
    const list = byCategory.get(item.category) ?? [];
    list.push(item);
    byCategory.set(item.category, list);
  }
  const lines: string[] = ["# Security audit", ""];
  for (const [cat, list] of byCategory) {
    lines.push(`## ${cat}`);
    for (const item of list) {
      const rec = item.recommendation ? ` — ${item.recommendation}` : "";
      lines.push(`- [${item.level.toUpperCase()}] ${item.message}${rec}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
