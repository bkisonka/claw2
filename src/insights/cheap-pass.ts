import type { Claw2Config } from "../config/types.js";
import { createClient } from "../core/llm.js";
import type { InsightReasonCode } from "./types.js";

export interface CheapPassParams {
  pastChatTitle: string;
  dateLabel: string;
  reasonCode: InsightReasonCode;
  currentBrief: string;
  excerpts: string[];
}

/**
 * Short formulation after accept / in auto.
 * Requires currentBrief — otherwise returns null (no filler).
 */
export async function runCheapPass(
  config: Claw2Config,
  params: CheapPassParams
): Promise<string | null> {
  const cheap = config.insights?.cheapPass;
  if (cheap?.enabled === false) return null;
  const brief = (params.currentBrief ?? "").trim();
  if (!brief) return null;
  const excerpts = params.excerpts.map((e) => e.trim()).filter(Boolean).slice(0, 4);
  if (!excerpts.length) return null;

  const maxTokens = cheap?.maxTokens ?? 180;
  const client = createClient(config);
  const model = config.llm?.model || "gpt-4o-mini";

  const system = `You link CURRENT conversation to a PAST chat. Source of truth = excerpts + current brief only.
Write 2–3 sentences explaining why this may help NOW.
Do not invent facts missing from the excerpts / current brief.
No persona, no filler — substance only.
For reasonCode unresolved_thread: emphasize returning to finish, not fake semantic depth.`;

  const user = `Past chat: "${params.pastChatTitle}" (${params.dateLabel})
reasonCode: ${params.reasonCode}

Current conversation (brief):
${brief.slice(0, 600)}

Past excerpts (only source of truth):
${excerpts.map((e, i) => `${i + 1}. ${e.slice(0, 400)}`).join("\n")}`;

  try {
    const res = await client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      temperature: 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const text = res.choices[0]?.message?.content?.trim() ?? "";
    return text || null;
  } catch (err) {
    console.error("[insights] cheap pass failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export function formatInsightAddendum(ctx: {
  pastChatTitle: string;
  dateLabel?: string;
  reasonCode: string;
  excerpts: string[];
  formulatedText?: string;
}): string {
  const lines = [
    "Retrieved prior dialogue (not your invention — only use what is below):",
    `Past chat: “${ctx.pastChatTitle}”${ctx.dateLabel ? ` (${ctx.dateLabel})` : ""}`,
    `reasonCode: ${ctx.reasonCode}`,
  ];
  if (ctx.formulatedText?.trim()) {
    lines.push(`Insight: ${ctx.formulatedText.trim()}`);
  }
  if (ctx.excerpts.length) {
    lines.push("Excerpts:");
    for (const e of ctx.excerpts.slice(0, 3)) {
      lines.push(`- ${e.trim().slice(0, 400)}`);
    }
  }
  lines.push(
    "If an insight block is provided, treat it as retrieved prior dialogue — not as your invention. Offer the connection briefly; do not claim memories that are not in the block. Prefer one concrete link (chat title + date + why it matters now)."
  );
  return lines.join("\n");
}
