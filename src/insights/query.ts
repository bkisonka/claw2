/** Build a compact linker query from the user turn + optional W page meta. */
export function buildInsightQuery(params: {
  userText: string;
  pageTitle?: string;
  pageKey?: string;
}): string {
  const parts: string[] = [];
  const text = (params.userText ?? "").trim();
  if (text) parts.push(text.slice(0, 500));
  const title = (params.pageTitle ?? "").trim();
  if (title) parts.push(title.slice(0, 200));
  const pageKey = (params.pageKey ?? "").trim();
  if (pageKey) {
    try {
      const u = new URL(pageKey.includes("://") ? pageKey : `https://${pageKey}`);
      parts.push(`${u.hostname}${u.pathname}`.slice(0, 200));
    } catch {
      parts.push(pageKey.slice(0, 200));
    }
  }
  return parts.join("\n").trim();
}

export function normalizeInsightTopic(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}
