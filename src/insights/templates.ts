import type { InsightAskTemplateKey, InsightReasonCode } from "./types.js";

export function askTemplateKeyForReason(reason: InsightReasonCode): InsightAskTemplateKey {
  return reason === "unresolved_thread" ? "unresolved_return" : "semantic_link";
}

/** Fallback English strings (UI prefers i18n). */
export function formatAskFallback(params: {
  reasonCode: InsightReasonCode;
  title: string;
  dateLabel: string;
}): string {
  const title = params.title || "Chat";
  if (params.reasonCode === "unresolved_thread") {
    return `We did not finish the discussion in “${title}” (${params.dateLabel}). Want to return?`;
  }
  return `Looks related to “${title}” (${params.dateLabel}). Show the connection?`;
}
