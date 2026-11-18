/**
 * Convert HTML responses to readable plain text for LLM context.
 * Content links become markdown [text](url); chrome/nav links are dropped.
 */

const BLOCK_TAGS =
  /<\/?(?:p|div|br|hr|li|tr|h[1-6]|blockquote|pre|section|article|header|footer|nav|ul|ol|table|td|th)\b[^>]*>/gi;

const STRUCTURAL_BLOCKS =
  /<(?:nav|header|footer|aside|menu)\b[^>]*>[\s\S]*?<\/(?:nav|header|footer|aside|menu)>/gi;

export function looksLikeHtml(text: string, contentType?: string | null): boolean {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("text/html") || ct.includes("application/xhtml")) return true;
  const head = text.slice(0, 800).toLowerCase();
  return (
    /<!doctype\s+html\b/.test(head) ||
    /<html[\s>]/.test(head) ||
    /<head[\s>]/.test(head) ||
    /<body[\s>]/.test(head)
  );
}

export function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated, total ${text.length} chars]`;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    });
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

/** Prefer article/main content when present. */
export function extractContentHtml(html: string): string {
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  if (article?.[1]?.trim()) return article[1];
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main?.[1]?.trim()) return main[1];
  const roleMain = html.match(
    /<([a-z0-9]+)\b[^>]*\brole\s*=\s*["']main["'][^>]*>([\s\S]*?)<\/\1>/i
  );
  if (roleMain?.[2]?.trim()) return roleMain[2];
  return html;
}

export function stripStructuralHtml(html: string): string {
  let s = html;
  s = s.replace(STRUCTURAL_BLOCKS, " ");
  // role=navigation|banner|contentinfo|complementary
  s = s.replace(
    /<([a-z0-9]+)\b[^>]*\brole\s*=\s*["'](?:navigation|banner|contentinfo|complementary)["'][^>]*>[\s\S]*?<\/\1>/gi,
    " "
  );
  return s;
}

/**
 * Keep http(s) / site-relative content links; drop chrome, empty, fragment-only.
 */
export function isContentHref(href: string, linkText: string): boolean {
  const h = (href || "").trim();
  const t = (linkText || "").trim();
  if (!h || !t) return false;
  if (/^(javascript|data|mailto|tel):/i.test(h)) return false;
  if (h === "#" || h.startsWith("#")) return false;
  // Absolute web or root/relative path
  if (/^https?:\/\//i.test(h)) return true;
  if (h.startsWith("/") || h.startsWith("./") || h.startsWith("../")) return true;
  // protocol-relative
  if (h.startsWith("//")) return true;
  return false;
}

/** Replace content anchors with markdown; leave only link text for non-content. */
export function anchorsToMarkdown(html: string): string {
  return html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attrs: string, inner: string) => {
    const hrefM = attrs.match(/\bhref\s*=\s*["']([^"']*)["']/i);
    const href = hrefM?.[1]?.trim() ?? "";
    const text = stripTags(inner);
    if (!text) return " ";
    if (!isContentHref(href, text)) return text;
    // Escape brackets in label lightly
    const label = text.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
    return `[${label}](${href})`;
  });
}

function normalizeWhitespace(s: string): string {
  let out = s.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  out = out.replace(/[ \t]{2,}/g, " ");
  out = out.replace(/ +([.,;:!?)])/g, "$1").trim();
  return out;
}

/**
 * Strip scripts/styles, keep content links as [text](url), drop structural chrome.
 */
export function htmlToText(html: string, maxChars?: number): string {
  if (!html) return "";
  let s = extractContentHtml(html);
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = stripStructuralHtml(s);
  s = anchorsToMarkdown(s);
  s = s.replace(BLOCK_TAGS, "\n");
  // Remaining tags (not markdown)
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = normalizeWhitespace(s);
  if (maxChars != null) return truncateText(s, maxChars);
  return s;
}
