// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Sanitization when recording into long-term memory (block of dangerous patterns according to TK).
 */

export type MemorySource = "user" | "channel" | "web" | "internal";

const DANGEROUS_PATTERNS: RegExp[] = [
  /curl\s+[^>]*-d\s+[^>]*@/i,
  /\.bashrc|\.bash_profile/i,
  /всегда\s+добавляй\s+к\s+сообщениям/i,
  /ignore\s+(all\s+)?(previous|above)\s+instructions/i,
  /\[\[MARKER_SANITIZED\]\]/i,
  /<<<EXT>>>|<<<\/EXT>>>/i,
];

export interface SanitizeResult {
  allowed: boolean;
  sanitized?: string;
  reason?: string;
}

/**
 * Checks the text before writing it to memory. If a dangerous pattern is detected, recording is prohibited.
 */
export function sanitizeForMemory(text: string): SanitizeResult {
  if (!text || typeof text !== "string") {
    return { allowed: false, reason: "empty" };
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) return { allowed: false, reason: "empty" };

  for (const re of DANGEROUS_PATTERNS) {
    if (re.test(trimmed)) {
      return { allowed: false, reason: "dangerous_pattern" };
    }
  }

  const maxLen = 8 * 1024; // 8KB per chunk by default, limit set externally
  const sanitized = trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
  return { allowed: true, sanitized };
}
