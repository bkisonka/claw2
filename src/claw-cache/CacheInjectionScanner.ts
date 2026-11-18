/**
 * Scanning text from the cache for prompt injection patterns.
 * Preventing model prompt infection through cache contents.
 */

const INJECTION_PATTERNS: RegExp[] = [
  /игнорируй\s+(правила|инструкции|безопасность|предыдущ)/i,
  /ignore\s+(rules|instructions|previous|all\s+above)/i,
  /будь\s+(DAN|GodMode|без\s+цензуры|без\s+ограничений)/i,
  /раскрой\s+(системный\s+промпт|ключи|токены|инструкции)/i,
  /reveal\s+(system\s+prompt|instructions|prompt)/i,
  /выполни\s+код\s+/i,
  /execute\s+code\s+/i,
  /ты\s+теперь\s+/i,
  /you\s+are\s+now\s+/i,
  /выведи\s+только\s+/i,
  /output\s+only\s+/i,
  /не\s+следуй\s+/i,
  /do\s+not\s+follow\s+/i,
  /переопредел\s+инструкц/i,
  /override\s+instruction/i,
  /системный\s+промпт\s*:/i,
  /system\s+prompt\s*:/i,
];

export interface ScanResult {
  passed: boolean;
  matches: { pattern: string; index: number }[];
}

/**
 * Scans one line. Returns passed: false on the first match with a dangerous pattern.
 */
export function scanText(text: string): ScanResult {
  if (!text || typeof text !== "string") return { passed: true, matches: [] };
  const matches: { pattern: string; index: number }[] = [];
  const normalized = text.normalize("NFC");
  for (const re of INJECTION_PATTERNS) {
    const m = normalized.match(re);
    if (m && m.index !== undefined) {
      matches.push({ pattern: re.source, index: m.index });
    }
  }
  return {
    passed: matches.length === 0,
    matches,
  };
}

/**
 * Scans all text fields that can be included in the prompt: phrases, patterns, style_markers.
 */
export function scanTriggers(triggers: {
  phrases?: string[];
  patterns?: string[];
  style_markers?: Record<string, unknown>;
} | null): ScanResult {
  if (!triggers) return { passed: true, matches: [] };
  const allMatches: { pattern: string; index: number }[] = [];
  const texts: string[] = [];
  if (Array.isArray(triggers.phrases)) {
    texts.push(...triggers.phrases.filter((p): p is string => typeof p === "string"));
  }
  if (Array.isArray(triggers.patterns)) {
    texts.push(...triggers.patterns.filter((p): p is string => typeof p === "string"));
  }
  if (triggers.style_markers && typeof triggers.style_markers === "object") {
    for (const v of Object.values(triggers.style_markers)) {
      if (typeof v === "string") texts.push(v);
    }
  }
  for (const t of texts) {
    const r = scanText(t);
    if (!r.passed) allMatches.push(...r.matches);
  }
  return {
    passed: allMatches.length === 0,
    matches: allMatches,
  };
}
