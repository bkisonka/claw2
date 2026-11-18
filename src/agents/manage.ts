import { unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Claw2Config } from "../config/types.js";
import { getAvailableAgents, type AgentInfo } from "./list.js";
import { writeAgent } from "./write-agent.js";
import { formatSkillHeader } from "./skill-header.js";

/**
 * Only a basic filename like name.js is allowed, no path and no ..
 */
export function safeScriptName(script: string): string | null {
  const s = script.trim();
  if (!s) return null;
  const withExt = s.endsWith(".js") ? s : `${s}.js`;
  const base = withExt.replace(/^.*[/\\]/, "");
  if (base !== withExt || base.includes("..") || base.length < 4) return null;
  return base;
}

export function normalizeDisabledAgents(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const safe = safeScriptName(String(item ?? ""));
    if (!safe || seen.has(safe)) continue;
    seen.add(safe);
    out.push(safe);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

export interface AgentStatus extends AgentInfo {
  enabled: boolean;
}

export function listAgentsWithStatus(config: Claw2Config): AgentStatus[] {
  const agentsDir = resolve(config.agentsDir ?? "agents");
  const disabled = new Set(normalizeDisabledAgents(config.disabledAgents));
  return getAvailableAgents(agentsDir).map((a) => ({
    ...a,
    enabled: !disabled.has(a.name),
  }));
}

export function getEnabledAgents(config: Claw2Config): AgentInfo[] {
  return listAgentsWithStatus(config)
    .filter((a) => a.enabled)
    .map(({ name, description, help, usageComplete }) => ({
      name,
      description,
      help,
      usageComplete,
    }));
}

export function isAgentEnabled(config: Claw2Config, script: string): boolean {
  const safe = safeScriptName(script);
  if (!safe) return false;
  const disabled = new Set(normalizeDisabledAgents(config.disabledAgents));
  return !disabled.has(safe);
}

export interface DeleteAgentResult {
  ok: boolean;
  message: string;
}

export function deleteAgent(config: Claw2Config, script: string): DeleteAgentResult {
  const safe = safeScriptName(script);
  if (!safe) {
    return { ok: false, message: "Invalid script name: must be a .js filename (e.g. my-agent.js), no path." };
  }
  const baseDir = resolve(config.agentsDir ?? "agents");
  const path = resolve(baseDir, safe);
  if (!path.startsWith(baseDir + "/") && !path.startsWith(baseDir + "\\")) {
    return { ok: false, message: "Path rejected." };
  }
  if (!existsSync(path)) {
    return { ok: false, message: `Agent not found: ${safe}` };
  }
  try {
    unlinkSync(path);
    return { ok: true, message: `Deleted agents/${safe}` };
  } catch (err) {
    return { ok: false, message: String(err) };
  }
}

export function createAgentStub(
  config: Claw2Config,
  script: string,
  description?: string,
  content?: string
): { ok: boolean; message: string; name?: string } {
  const safe = safeScriptName(script);
  if (!safe) {
    return { ok: false, message: "Invalid script name: must be a .js filename (e.g. my-agent.js), no path." };
  }
  const desc = (description ?? "").trim() || safe.replace(/\.js$/, "");
  const body =
    content?.trim() ||
    `${formatSkillHeader({
      description: desc,
      call: `run_agent({script:"${safe}"})`,
      input: "no args (stub — replace with real I/O)",
      output: 'stdout: {"ok":true}; exit 0',
    })}\nconsole.log(JSON.stringify({ ok: true, agent: ${JSON.stringify(safe)} }));\n`;
  const result = writeAgent(config, { script: safe, content: body });
  return { ...result, name: result.ok ? safe : undefined };
}

export function setAgentEnabledInList(disabled: string[], script: string, enabled: boolean): string[] {
  const safe = safeScriptName(script);
  if (!safe) return normalizeDisabledAgents(disabled);
  const set = new Set(normalizeDisabledAgents(disabled));
  if (enabled) set.delete(safe);
  else set.add(safe);
  return [...set].sort((a, b) => a.localeCompare(b));
}
