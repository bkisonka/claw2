import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Claw2Config } from "../config/types.js";
import { validateSkillSource } from "./skill-header.js";

/**
 * Only a basic filename like name.js is allowed, no path and no ..
 */
function safeScriptName(script: string): string | null {
  const s = script.trim();
  if (!s.endsWith(".js")) return null;
  const base = s.replace(/^.*[/\\]/, "");
  if (base !== s || base.includes("..") || base.length < 4) return null;
  return base;
}

export interface WriteAgentOptions {
  script: string;
  content: string;
  /** skipHeaderCheck - only for internal stub/migrations*/
  skipHeaderCheck?: boolean;
}

export interface WriteAgentResult {
  ok: boolean;
  message: string;
}

/**
 * Writes the agent file only to agentsDir and only with the name *.js (without path traversal).
 * Requires the canonical header Agent/Call/In/Out (for the run_agent directory).
 */
export function writeAgent(config: Claw2Config, options: WriteAgentOptions): WriteAgentResult {
  const safe = safeScriptName(options.script);
  if (!safe) {
    return { ok: false, message: "Invalid script name: must be a .js filename (e.g. my-agent.js), no path." };
  }
  const baseDir = resolve(config.agentsDir ?? "agents");
  const path = resolve(baseDir, safe);
  if (!path.startsWith(baseDir + "/") && !path.startsWith(baseDir + "\\")) {
    return { ok: false, message: "Path rejected." };
  }
  if (!options.skipHeaderCheck) {
    const check = validateSkillSource(safe, options.content);
    if (!check.ok) return { ok: false, message: check.error };
  }
  try {
    writeFileSync(path, options.content, "utf-8");
    return { ok: true, message: `Saved agents/${safe}` };
  } catch (err) {
    return { ok: false, message: String(err) };
  }
}
