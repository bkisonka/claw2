/**
 * Checking whether the skill is allowed by allowlist (stage 3, preparation).
 * When calling the skill module, call isSkillAllowed; if false - refusal.
 */
import type { Claw2Config } from "../config/types.js";

export function isSkillAllowed(config: Claw2Config, skillId: string): boolean {
  const list = config.skills?.allowlist;
  if (!list || list.length === 0) return false;
  const id = String(skillId ?? "").trim();
  return id !== "" && list.includes(id);
}

/**
 * Run-gate for run_agent. A non-empty skills.allowlist fences execution to
 * exactly its entries: the model can still draft a new skill, but the run is
 * refused until the user lists it. Empty/unset list keeps self-extension open
 * (the default for a personal agent).
 */
export function isSkillRunAllowed(config: Claw2Config, skillId: string): boolean {
  const list = config.skills?.allowlist;
  if (!list || list.length === 0) return true;
  return isSkillAllowed(config, skillId);
}
