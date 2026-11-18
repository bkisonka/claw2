/**
 * Fast-path hints when the user clearly asks to place an outbound call.
 * Goal: first tool round = phone_call(dial), not status/search/monologue.
 */

const CALL_VERB_RE =
  /(?:позвон\w*|набер\w*|созвон\w*|дозвон\w*|\bcall\b|\bdial\b|\bphone\b)/i;

/** Digits with optional + / spaces / dashes — at least 10 digits total. */
const PHONE_CANDIDATE_RE = /(?:\+?\d[\d\s\-()]{8,}\d)/g;

export const PHONE_DIAL_HINT_SUFFIX =
  "\n\n[claw2] Outbound call requested. Your FIRST tool call in this turn must be phone_call with action=\"dial\" and to=<the number from the user message>. Do NOT call status, search, or web tools first. After dial returns call.state=active, say a short greeting, then listen — and keep the conversation going (say↔listen). Do NOT hangup until the user in this chat asks to end the call.";

export function shouldHintDial(message: string): boolean {
  const t = message.trim();
  if (!t || t.length > 2000) return false;
  if (!CALL_VERB_RE.test(t)) return false;
  return extractDialTarget(t) != null;
}

/** Best-effort phone/SIP target from user text. */
export function extractDialTarget(message: string): string | undefined {
  const sip = message.match(/\bsip:[^\s>;]+/i);
  if (sip?.[0]) return sip[0].trim();

  const matches = message.match(PHONE_CANDIDATE_RE) ?? [];
  let best: string | undefined;
  let bestDigits = 0;
  for (const raw of matches) {
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) continue;
    if (digits.length > bestDigits) {
      bestDigits = digits.length;
      best = digits;
    }
  }
  return best;
}
