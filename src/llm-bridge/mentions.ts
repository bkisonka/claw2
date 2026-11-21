// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/** Alias ​​for @mention: agentId, displayName, participantLabels[agentId].*/
export function getMentionAliases(
  agentId: string,
  displayName: string,
  participantLabels: Record<string, string>
): string[] {
  const set = new Set<string>();
  const id = agentId.trim();
  if (id) set.add(id);
  const dn = displayName.trim();
  if (dn) set.add(dn);
  const label = participantLabels[id]?.trim();
  if (label) set.add(label);
  return [...set];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Is there a @mention of one of the aliases in the text (without continuing the word: @beta ≠ @betax).*/
export function isAgentMentioned(text: string, aliases: string[]): boolean {
  if (!text.trim() || aliases.length === 0) return false;
  for (const alias of aliases) {
    if (!alias) continue;
    const re = new RegExp(`@${escapeRegex(alias)}(?![\\p{L}\\p{N}_])`, "iu");
    if (re.test(text)) return true;
  }
  return false;
}

/** Calling by name without @ (for other LLMs' remarks: “Alpha, hello”).*/
export function isAddressedByName(text: string, aliases: string[]): boolean {
  if (!text.trim() || aliases.length === 0) return false;
  for (const alias of aliases) {
    if (!alias) continue;
    const re = new RegExp(
      `(?<![@\\p{L}\\p{N}_])${escapeRegex(alias)}(?![\\p{L}\\p{N}_])`,
      "iu"
    );
    if (re.test(text)) return true;
  }
  return false;
}

export type AutoReplyMode = "all" | "mention";

export function normalizeAutoReplyMode(mode: string | undefined): AutoReplyMode {
  return mode === "mention" ? "mention" : "all";
}
