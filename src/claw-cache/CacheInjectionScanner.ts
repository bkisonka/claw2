/**
 * Scanning text from the cache for prompt injection patterns.
 * Preventing model prompt infection through cache contents.
 *
 * Design constraints for the sharing scenario (caches exchanged between
 * users): the scanner is a *filter*, not a guarantee. A shared cache is a
 * third-party prompt in the shape of history; containment (warmup-containment)
 * and provenance (cache-signature) limit what a missed pattern can do. The
 * scanner fails closed: any hit in any checked window rejects the content.
 *
 * Normalization before matching: invisible/bidi characters stripped, NFKC,
 * combining marks stripped (diacritics), casefold, homoglyph confusables
 * folded to Latin. Both the input text and the patterns pass through the same
 * fold, so mixed-script obfuscation ("systеm prompt" with a Cyrillic е) still
 * matches while plain Cyrillic and Latin patterns keep working.
 */

export type ScanCategory =
  | "instruction_override"
  | "jailbreak_persona"
  | "prompt_extraction"
  | "capability_claim"
  | "exfiltration"
  | "output_control"
  | "role_spoof"
  | "format_marker"
  | "sentinel_spoof";

export interface ScanMatch {
  /** re.source of the matched pattern (stable id for audit). */
  pattern: string;
  category: ScanCategory;
  index: number;
  /** Matched substring, trimmed for audit/log size. */
  sample: string;
}

export interface ScanResult {
  passed: boolean;
  matches: ScanMatch[];
}

interface CategorizedPattern {
  re: RegExp;
  category: ScanCategory;
}

const INJECTION_PATTERNS: CategorizedPattern[] = [
  // Instruction override / system obedience reset
  { category: "instruction_override", re: /игнорир(уй|овать|уем)\s+(все|вс[её]|правила|инструкции|безопасность|предыдущ|ограничения)/i },
  { category: "instruction_override", re: /ignore\s+(all\s+)?((previous|above|prior|existing)\s+)?(rules|instructions|safety|prompts?)/i },
  { category: "instruction_override", re: /(забудь|забыть)\s+(вс[её]|предыдущ|инструкции|правила)/i },
  { category: "instruction_override", re: /forget\s+(everything|all|your\s+instructions|previous)/i },
  { category: "instruction_override", re: /disregard\s+(all|previous|the\s+above|your)/i },
  { category: "instruction_override", re: /не\s+следуй\s+/i },
  { category: "instruction_override", re: /do\s+not\s+follow\s+/i },
  { category: "instruction_override", re: /переопредел\s+инструкц/i },
  { category: "instruction_override", re: /override\s+(instruction|rules|safety)/i },
  { category: "instruction_override", re: /новые\s+правила\s*:|new\s+rules\s*:/i },
  { category: "instruction_override", re: /(твои|your)\s+(новые|настоящие|реальные|new|real|actual|true)\s+(инструкции|правила|instructions|rules)/i },

  // Jailbreak personas
  { category: "jailbreak_persona", re: /будь\s+(DAN|GodMode|без\s+цензуры|без\s+ограничений)/i },
  { category: "jailbreak_persona", re: /you\s+are\s+now\s+/i },
  { category: "jailbreak_persona", re: /ты\s+теперь\s+/i },
  { category: "jailbreak_persona", re: /(притворись|представь\s+себе,?\s+что\s+ты\s+(не|никто))/i },
  { category: "jailbreak_persona", re: /pretend\s+(you\s+are|to\s+be)\s+/i },
  { category: "jailbreak_persona", re: /(jailbreak|developer\s+mode|godmode|unfiltered\s+mode)/i },
  { category: "jailbreak_persona", re: /без\s+цензуры|no\s+censorship|без\s+фильтров|nsfw\s+mode/i },
  { category: "jailbreak_persona", re: /act\s+as\s+if\s+you\s+(were|are)\s+not\s+/i },

  // Prompt extraction
  { category: "prompt_extraction", re: /раскрой\s+(системный\s+промпт|ключи|токены|инструкции)/i },
  { category: "prompt_extraction", re: /reveal\s+(system\s+prompt|instructions|prompt|your\s+instructions)/i },
  { category: "prompt_extraction", re: /системный\s+промпт\s*:|system\s+prompt\s*:/i },
  { category: "prompt_extraction", re: /(что|какая)\s+(у\s+тебя\s+)?(твой|ваш)?\s*(системный|system)\s*(промпт|инструкц)/i },
  { category: "prompt_extraction", re: /what\s+is\s+your\s+(system\s+prompt|instruction|initial\s+prompt)/i },
  { category: "prompt_extraction", re: /(повтори|воспроизведи|выведи)\s+(свой|твои|полные|точные)\s+(инструкц|промпт|правила)/i },
  { category: "prompt_extraction", re: /repeat\s+(your|the)\s+(instructions|prompt|system)/i },
  { category: "prompt_extraction", re: /print\s+(your|the)\s+(prompt|instructions|system)/i },

  // Capability claims (fictional privileges asserted as history)
  { category: "capability_claim", re: /(у\s+меня\s+есть|я\s+имею)\s+(полный\s+|прямой\s+|постоянный\s+)?(доступ|права)\s+(к|на|в)/i },
  { category: "capability_claim", re: /i\s+(have|has)\s+(full\s+|root\s+|admin\s+|system\s+|direct\s+)?(access|permissions)\s+to/i },
  { category: "capability_claim", re: /я\s+(могу|уже\s+(выполнял|запускал|исполнял|читал|менял))\s+(любой\s+|твой\s+|ваш\s+)?(код|команды?|скрипты?|shell|bash|файлы|терминал)/i },
  { category: "capability_claim", re: /i\s+can\s+(execute|run)\s+(any\s+|arbitrary\s+|your\s+)?(code|commands?|scripts?|shell)/i },
  { category: "capability_claim", re: /(исполняю|выполняю|запускаю)\s+(код|команды|скрипты|shell|bash)/i },
  { category: "capability_claim", re: /выполни\s+код\s+|execute\s+code\s+/i },
  { category: "capability_claim", re: /(root|sudo|shell|bash|admin)\s+доступ|доступ\s+к\s+(терминалу|системе|файлам|вашим\s+файлам)/i },
  { category: "capability_claim", re: /(root|sudo|shell|terminal)\s+(access|permission)/i },
  { category: "capability_claim", re: /(я\s+)?(уже\s+)?(прочитал|читаю|вижу)\s+(твои|ваши)\s+(файлы|ключи|токены|переписку)/i },

  // Exfiltration
  { category: "exfiltration", re: /отправ(ь|ьте|ить)\s+(все\s+|эти\s+)?(данные|ключи|токены|историю|переписку|креды)/i },
  { category: "exfiltration", re: /send\s+(all\s+|the\s+)?(data|keys|tokens|history|conversation|credentials)/i },
  { category: "exfiltration", re: /exfiltrat/i },
  { category: "exfiltration", re: /выведи\s+перечень\s+(ключей|токенов)|list\s+(all\s+)?(api\s+)?(keys|tokens|secrets)/i },

  // Output control
  { category: "output_control", re: /выведи\s+только\s+|output\s+only\s+/i },
  { category: "output_control", re: /отвечай\s+только\s+|respond\s+only\s+with\s+/i },
  { category: "output_control", re: /всегда\s+(отвечай|начинай)\s+с?\s*(только|фразы)/i },
  { category: "output_control", re: /always\s+(respond|answer|start)\s+(only\s+)?with\s+/i },

  // Role/format spoofing (fake structure inside a single cache message)
  { category: "role_spoof", re: /(^|\n)\s*(system|assistant|user|разработчик|developer)\s*:/im },
  { category: "role_spoof", re: /\[(system|assistant|inst)\]|\[\/*system\]/i },
  { category: "role_spoof", re: /<(system|\/system|inst|\/inst|user|\/user)>/i },

  // Model/format control tokens
  { category: "format_marker", re: /<\|(im_start|im_end|endoftext|eot|system)\|>/i },
  { category: "format_marker", re: /<\/*ext>/i },
  { category: "format_marker", re: /###\s*system\s*:|###\s*инструкции\s*:/i },

  // Containment sentinel spoofing (tokens from warmup-containment.ts)
  { category: "sentinel_spoof", re: /imported_warmup/i },
  { category: "sentinel_spoof", re: /<<<\s*(warmup|system|imported)/i },
];

/**
 * Characters that carry no visible meaning but can smuggle matches or visual
 * confusion: control chars (except \n \t \r), soft hyphen, zero-width, bidi
 * overrides, invisibles, tag chars, variation selectors.
 */
const INVISIBLE_CHARS_RE =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}\uFE00-\uFE0F\u1AB0-\u1AFF\u1DC0-\u1DFF]/gu;

/** Cyrillic/Greek letters visually confusable with Latin, folded to Latin. */
const CONFUSABLE_MAP: Record<string, string> = {
  а: "a", с: "c", е: "e", о: "o", р: "p", х: "x", у: "y", к: "k", м: "m", т: "t", в: "b", д: "d",
  А: "a", С: "c", Е: "e", О: "o", Р: "p", Х: "x", У: "y", К: "k", М: "m", Т: "t", В: "b", Н: "h", Д: "d",
  ο: "o", ρ: "p", ν: "v", ι: "i", α: "a", ε: "e", τ: "t", κ: "k", μ: "m",
};

/**
 * Fold text into the canonical form used for pattern matching. Applied to both
 * scanned text and patterns, so the fold is symmetric and never breaks plain
 * Cyrillic/Latin matching.
 */
export function normalizeScanText(text: string): string {
  let s = text.normalize("NFC").replace(INVISIBLE_CHARS_RE, "");
  s = s.normalize("NFD").replace(/[\u0300-\u036F\u0483-\u0489\u0591-\u05BD\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20F0\uFE20-\uFE2F]/g, "").normalize("NFC");
  s = s.toLowerCase();
  let out = "";
  for (const ch of s) {
    out += Object.prototype.hasOwnProperty.call(CONFUSABLE_MAP, ch) ? (CONFUSABLE_MAP[ch] ?? ch) : ch;
  }
  return out;
}

/** Patterns folded once at module load; matching runs on folded text. */
const FOLDED_PATTERNS: CategorizedPattern[] = INJECTION_PATTERNS.map((p) => ({
  category: p.category,
  re: new RegExp(normalizeScanText(p.re.source), p.re.flags),
}));

function sampleAt(text: string, index: number): string {
  return text.slice(index, index + 60).replace(/\s+/g, " ").trim().slice(0, 60);
}

/**
 * Scans one text. Fails on the first match. Input is folded before matching;
 * the original (unfolded) text is only used for the sample.
 */
export function scanText(text: string): ScanResult {
  if (!text || typeof text !== "string") return { passed: true, matches: [] };
  const normalized = normalizeScanText(text);
  const matches: ScanMatch[] = [];
  for (const p of FOLDED_PATTERNS) {
    const m = normalized.match(p.re);
    if (m && m.index !== undefined) {
      matches.push({
        pattern: p.re.source,
        category: p.category,
        index: m.index,
        sample: sampleAt(text, m.index),
      });
    }
  }
  return { passed: matches.length === 0, matches };
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
  const allMatches: ScanMatch[] = [];
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
  return { passed: allMatches.length === 0, matches: allMatches };
}

export interface DialogueScanMessage {
  role: string;
  content: string;
}

export interface DialogueScanIssue {
  /** 0-based message index in the checked slice. */
  line: number;
  role: string | null;
  /** 1 = single message, 2/3 = adjacent-window scan. */
  windowSize: number;
  matches: ScanMatch[];
}

export interface DialogueScanResult {
  passed: boolean;
  issues: DialogueScanIssue[];
  checked: number;
}

const DEFAULT_WINDOW_SIZES = [1, 2, 3];

/**
 * Scans a dialogue slice fail-closed: every message individually plus sliding
 * windows of adjacent messages (attacks split across a fake user/assistant
 * pair pass per-message checks but surface in the joined text).
 */
export function scanDialogueMessages(
  messages: DialogueScanMessage[],
  windowSizes: number[] = DEFAULT_WINDOW_SIZES
): DialogueScanResult {
  const issues: DialogueScanIssue[] = [];
  let checked = 0;
  for (const size of windowSizes) {
    for (let i = 0; i + size <= messages.length; i++) {
      const window = messages.slice(i, i + size);
      const joined = window.map((m) => String(m.content ?? "")).join("\n");
      checked += 1;
      const r = scanText(joined);
      if (!r.passed) {
        issues.push({
          line: i,
          role: window[0]?.role ?? null,
          windowSize: size,
          matches: r.matches,
        });
      }
    }
  }
  return { passed: issues.length === 0, issues, checked };
}

/**
 * Display-safe text for catalog/UI surfaces: strips control/invisible
 * characters and newlines so manifest fields cannot forge UI structure.
 */
export function sanitizeDisplayText(text: unknown, maxLen = 300): string {
  if (typeof text !== "string") return "";
  return text
    .replace(INVISIBLE_CHARS_RE, "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, maxLen);
}
