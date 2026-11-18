/**
 * Live-call persona prompt — injected only while telephony is in use
 * (active SIP call, dial intent, or after phone_call tool in the turn).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const FALLBACK = `You are on a live phone line via phone_call. Be a polite, warm, pleasant conversationalist.
Greet briefly after connect (say), then listen. Continue say ↔ listen while the call is active.
Do NOT hang up after one exchange or because listen returned text/silence.
Only hangup when the user in this chat asks to end the call, or the tool shows no active call.
If listen is empty/unclear, ask a short question on the line and listen again.
Keep say lines concise for voice. Trust tool JSON for call state.`;

function candidatePaths(): string[] {
  const out: string[] = [];
  const stateDir = process.env.CLAW2_STATE_DIR?.trim();
  if (stateDir) out.push(join(resolve(stateDir), "telephony.md"));
  const home = homedir();
  if (home) out.push(join(home, ".claw2", "telephony.md"));
  // Packaged gateway cwd is claw2-runtime/
  out.push(resolve(process.cwd(), "prompts", "telephony.md"));
  out.push(resolve(process.cwd(), ".claw2", "telephony.md"));
  out.push(resolve(process.cwd(), "..", "prompts", "telephony.md"));
  out.push(join(resolve(process.cwd()), "dist", "..", "prompts", "telephony.md"));
  return out;
}

/** Strip leading # title; keep body. */
function normalizeMarkdown(raw: string): string {
  const t = raw.replace(/^\uFEFF/, "").trim();
  if (!t) return FALLBACK;
  const lines = t.split(/\r?\n/);
  if (lines[0]?.startsWith("#")) {
    return lines.slice(1).join("\n").trim() || FALLBACK;
  }
  return t;
}

export function getTelephonyConversationPrompt(): string {
  for (const p of candidatePaths()) {
    try {
      if (!existsSync(p)) continue;
      const body = normalizeMarkdown(readFileSync(p, "utf8"));
      if (body) return body;
    } catch {
      /* try next */
    }
  }
  return FALLBACK;
}

export function buildTelephonyContextBlock(): string {
  return `[Telephony — live call]\n${getTelephonyConversationPrompt()}`;
}
