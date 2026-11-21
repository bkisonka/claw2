// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import type { PrivacyCustomRule, ReplaceFn } from "./types.js";

const MAX_PATTERN_LEN = 256;
const MAX_NAME_LEN = 64;
const MAX_RULES = 100;

const RESERVED_KINDS = new Set([
  "EMAIL",
  "CARD",
  "IPV4",
  "SNILS",
  "PASSPORT_RU",
  "PHONE",
  "INN",
  "DATETIME",
  "IDENTITY",
  "ORG",
  "BIK",
  "BANK_ACCOUNT",
  "KPP",
]);

export interface CompiledCustomRule {
  id: string;
  name: string;
  kind: string;
  ruleType: "keyword" | "regex";
  regex: RegExp;
}

export function kindSlugFromName(name: string): string {
  const base = (name || "RULE")
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase() || "RULE";
  let kind = `USER_${base.slice(0, 28)}`;
  const bare = kind.slice(5);
  if (RESERVED_KINDS.has(bare) || RESERVED_KINDS.has(kind)) {
    kind = `USER_${base.slice(0, 24)}_X`.slice(0, 40);
  }
  return kind;
}

export function validateRulePattern(ruleType: string, pattern: string): string {
  const t = (ruleType || "").trim().toLowerCase();
  if (t !== "keyword" && t !== "regex") {
    throw new Error("rule_type must be 'keyword' or 'regex'");
  }
  const text = (pattern || "").trim();
  if (!text) throw new Error("pattern is required");
  if (text.length > MAX_PATTERN_LEN) {
    throw new Error(`pattern must be at most ${MAX_PATTERN_LEN} characters`);
  }
  if (t === "regex") {
    try {
      // eslint-disable-next-line no-new
      new RegExp(text);
    } catch (err) {
      throw new Error(`invalid regex: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return text;
}

export function compileCustomRule(rule: PrivacyCustomRule): CompiledCustomRule {
  const name = (rule.name || "RULE").trim().slice(0, MAX_NAME_LEN) || "RULE";
  const ruleType = rule.ruleType === "regex" ? "regex" : "keyword";
  const pattern = validateRulePattern(ruleType, rule.pattern);
  const kind = kindSlugFromName(name);
  const flags = rule.caseSensitive ? "" : "i";
  let regex: RegExp;
  if (ruleType === "regex") {
    regex = new RegExp(pattern, flags);
  } else if (rule.wholeWord) {
    regex = new RegExp(`(?<!\\w)${escapeRegExp(pattern)}(?!\\w)`, flags);
  } else {
    regex = new RegExp(escapeRegExp(pattern), flags);
  }
  return {
    id: rule.id,
    name,
    kind,
    ruleType,
    regex,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compileCustomRules(rules: PrivacyCustomRule[] | undefined): CompiledCustomRule[] {
  if (!Array.isArray(rules) || rules.length === 0) return [];
  const enabled = rules
    .filter((r) => r && r.enabled !== false)
    .slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id))
    .slice(0, MAX_RULES);
  const out: CompiledCustomRule[] = [];
  for (const rule of enabled) {
    try {
      out.push(compileCustomRule(rule));
    } catch {
      /* skip invalid */
    }
  }
  return out;
}

export function applyCustomRules(
  text: string,
  rules: CompiledCustomRule[],
  replace: ReplaceFn
): string {
  if (!text || rules.length === 0) return text;
  let out = text;
  for (const rule of rules) {
    out = out.replace(rule.regex, (fragment) => {
      if (fragment.includes("[PII_")) return fragment;
      return replace(rule.kind, fragment);
    });
  }
  return out;
}
