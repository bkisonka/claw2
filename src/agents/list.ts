import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseSkillHeader, type ParsedSkillHeader } from "./skill-header.js";

export interface AgentInfo {
  name: string;
  /** Short line from `//Agent: ...` (UI/list).*/
  description: string;
  /** How to call: Call/In/Out for the model.*/
  help: string;
  /** The cap is complete (Agent+Call+In+Out).*/
  usageComplete: boolean;
}

/** @deprecated use parseSkillHeader */
export function parseAgentHeader(source: string): { description: string; help: string } {
  const p = parseSkillHeader(source);
  return { description: p.description, help: p.help };
}

/**
 * Scans agentsDir: list of .js and description/usage from the canonical header.
 */
export function getAvailableAgents(agentsDir: string): AgentInfo[] {
  const result: AgentInfo[] = [];
  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return result;
  }
  for (const file of entries) {
    if (!file.endsWith(".js")) continue;
    if (file.startsWith(".")) continue;
    const path = join(agentsDir, file);
    let description = file;
    let help = "";
    let usageComplete = false;
    try {
      const content = readFileSync(path, "utf-8");
      const parsed: ParsedSkillHeader = parseSkillHeader(content);
      if (parsed.description) description = parsed.description;
      help = parsed.help;
      usageComplete = parsed.complete;
    } catch {
      // ignore
    }
    result.push({ name: file, description, help, usageComplete });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
