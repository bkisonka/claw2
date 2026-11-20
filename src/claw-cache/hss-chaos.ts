/**
 * Lightweight input "chaos" heuristic: contradictions, instruction flips, language mixing.
 * Complements ΔS from HSS — does not replace ρ, but correlates better with contradictory text.
 */

/** Max. addition to effectiveDelta from chaosScore (0..1).*/
export const CHAOS_DELTA_BOOST_MAX = 0.003;

const CONTRADICTION_PATTERNS: RegExp[] = [
  /\bно\s+нет\b/gi,
  /\bхотя\s+нет\b/gi,
  /\bошибаешься\b/gi,
  /\bнаоборот\b/gi,
  /\bс\s+одной\s+стороны\b[\s\S]{0,200}\bс\s+другой\b/gi,
  /\bне\s+делай\b[\s\S]{0,300}\bобязательно\b/gi,
];

const OPPOSING_PAIRS: [string, string][] = [
  ["москв", "арзамас"],
  ["веган", "стейк"],
  ["русск", "english"],
  ["english only", "по-русски"],
  ["+30", "−25"],
  ["+30", "-25"],
  ["жарко", "холодно"],
  ["кратк", "подробн"],
  ["одном предложении", "три страниц"],
];

export function computeChaosScore(text: string): number {
  if (!text?.trim()) return 0;
  const lower = text.toLowerCase();
  let score = 0;

  for (const pattern of CONTRADICTION_PATTERNS) {
    if (pattern.test(lower)) score += 0.12;
  }

  for (const [a, b] of OPPOSING_PAIRS) {
    if (lower.includes(a) && lower.includes(b)) score += 0.18;
  }

  const flipMarkers = lower.match(
    /\b(не используй|обязательно|запрещено|не делай|не упоминай|нужен|не нужен|без|только)\b/g
  );
  // Long instructions/docs often contain “only/without/need”—the threshold is higher.
  const flipMin = text.length > 800 ? 10 : 5;
  if (flipMarkers && flipMarkers.length >= flipMin) score += 0.15;

  const hasCyrillic = /[а-яё]/i.test(text);
  const hasLatin = /[a-z]/i.test(text);
  // A mixture of languages ​​in a short, contradictory input is a signal; in a long answer with a code/URL is the norm.
  if (hasCyrillic && hasLatin && text.length > 80 && text.length < 600) score += 0.1;

  return Math.min(1, score);
}

export function chaosScoreToDeltaBoost(chaosScore: number): number {
  return chaosScore * CHAOS_DELTA_BOOST_MAX;
}
