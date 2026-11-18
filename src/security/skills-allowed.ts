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
