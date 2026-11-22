// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/** Allowed tags for type="html" (the rest are removed). "style" tags are stripped entirely (CSS url() exfil). */
const ALLOWED_HTML_TAGS = new Set([
  "div", "span", "p", "br", "table", "thead", "tbody", "tfoot", "colgroup", "col", "caption", "tr", "th", "td",
  "ul", "ol", "li", "h1", "h2", "h3", "h4", "strong", "em", "b", "i",
  "svg", "path", "circle", "rect", "line", "ellipse", "polygon", "polyline",
  "g", "text", "tspan", "title", "defs", "use", "lineargradient", "radialgradient", "stop", "clippath",
  "a", "img",
]);
/** Common SVG attributes (transform, fill, stroke, etc.).*/
const SVG_COMMON_ATTRS = new Set([
  "class", "style", "id", "transform", "fill", "stroke", "stroke-width", "stroke-linecap",
  "stroke-linejoin", "stroke-dasharray", "fill-opacity", "stroke-opacity", "opacity",
]);
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel"]),
  img: new Set(["src", "alt", "width", "height"]),
  svg: new Set(["viewBox", "width", "height", "xmlns", "preserveAspectRatio", "class", "style"]),
  path: new Set([...SVG_COMMON_ATTRS, "d"]),
  circle: new Set([...SVG_COMMON_ATTRS, "cx", "cy", "r"]),
  rect: new Set([...SVG_COMMON_ATTRS, "x", "y", "width", "height", "rx", "ry"]),
  line: new Set([...SVG_COMMON_ATTRS, "x1", "y1", "x2", "y2"]),
  ellipse: new Set([...SVG_COMMON_ATTRS, "cx", "cy", "rx", "ry"]),
  polygon: new Set([...SVG_COMMON_ATTRS, "points"]),
  polyline: new Set([...SVG_COMMON_ATTRS, "points"]),
  g: new Set([...SVG_COMMON_ATTRS]),
  text: new Set([...SVG_COMMON_ATTRS, "x", "y", "dx", "dy", "text-anchor", "font-size", "font-family"]),
  tspan: new Set([...SVG_COMMON_ATTRS, "x", "y", "dx", "dy"]),
  defs: new Set(["id"]),
  use: new Set(["href", "x", "y", "width", "height"]),
  lineargradient: new Set(["id", "x1", "y1", "x2", "y2", "gradientunits"]),
  radialgradient: new Set(["id", "cx", "cy", "r", "fx", "fy"]),
  stop: new Set(["offset", "stop-color", "stop-opacity"]),
  clippath: new Set(["id"]),
  div: new Set(["class", "style", "id"]),
  span: new Set(["class", "style"]),
  table: new Set(["class", "style", "border", "cellpadding", "cellspacing", "width"]),
  colgroup: new Set(["class", "style", "span"]),
  col: new Set(["class", "style", "span", "width"]),
  caption: new Set(["class", "style"]),
  td: new Set(["class", "style", "colspan", "rowspan", "align", "valign"]),
  th: new Set(["class", "style", "colspan", "rowspan", "align", "valign", "scope"]),
  tr: new Set(["class", "style"]),
  style: new Set(["type"]),
};
const DEFAULT_ALLOWED_ATTRS = new Set(["class", "style", "id"]);

/** Lowercased attr names for the allowlist check; original casing is kept on output. */
const ALLOWED_ATTRS_LOWER: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(ALLOWED_ATTRS).map(([tag, set]) => [tag, new Set([...set].map((a) => a.toLowerCase()))])
);
const DEFAULT_ALLOWED_ATTRS_LOWER = new Set([...DEFAULT_ALLOWED_ATTRS].map((a) => a.toLowerCase()));

/* ---------- URL scheme allowlist (href/src), entity-aware ----------
 * The scheme of a link must be judged the way the BROWSER will judge it, not
 * the way the raw attribute reads: the HTML parser decodes character
 * references ("&#106;avascript:" → "javascript:") and the URL parser strips
 * tab/LF/CR from anywhere inside the URL ("jav\tascript:" → "javascript:").
 * A raw-prefix check misses both (audited 2026-11; the PWA port carries the
 * same decoder — keep the two in sync). Deterministic: no DOM involved.
 */

/** Named refs that can contribute ASCII to a scheme prefix (HTML5 names, case-sensitive). */
const URL_ENTITIES: Record<string, string> = {
  amp: "&", AMP: "&", lt: "<", LT: "<", gt: ">", GT: ">", quot: '"', QUOT: '"', apos: "'",
  colon: ":", semi: ";", sol: "/", bsol: "\\", num: "#",
  Tab: "\t", NewLine: "\n", nbsp: " ",
  equals: "=", plus: "+", percnt: "%", quest: "?", excl: "!",
  dollar: "$", commat: "@", under: "_", ast: "*", midast: "*",
  Hat: "^", grave: "`", verbar: "|", lbrack: "[", rbrack: "]",
  lbrace: "{", rbrace: "}", lpar: "(", rpar: ")",
};

function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return "\uFFFD";
  try {
    return String.fromCodePoint(n);
  } catch {
    return "\uFFFD";
  }
}

function decodeUrlEntities(val: string): string {
  let out = val;
  // Bounded unrolling: "&amp;#106;" needs two passes to become "j".
  for (let i = 0; i < 3; i++) {
    const next = out
      .replace(/&#[xX]([0-9a-fA-F]+);?/g, (_, h: string) => safeCodePoint(parseInt(h, 16)))
      .replace(/&#([0-9]+);?/g, (_, d: string) => safeCodePoint(parseInt(d, 10)))
      .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m: string, name: string) => URL_ENTITIES[name] ?? m);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Attribute value as the browser sees it when resolving the URL. */
function normalizedUrlTarget(val: string): string {
  return decodeUrlEntities(val).replace(/[\t\n\r]/g, "").trim();
}

/** Scheme prefix ("javascript:", "https:"), or null for a relative reference. */
function urlScheme(normalized: string): string | null {
  const m = normalized.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  return m ? m[1].toLowerCase() : null;
}

const SAFE_HREF_SCHEMES = new Set(["http", "https", "mailto"]);
const SAFE_SRC_SCHEMES = new Set(["http", "https"]);

/** href/src must be a relative reference or carry an allowlisted scheme. */
function isSafeUrlTarget(val: string, attr: "href" | "src"): boolean {
  const normalized = normalizedUrlTarget(val);
  const scheme = urlScheme(normalized);
  if (scheme === null) return true; // relative "#x", "/files/…", "img.png" — resolves in-app
  if (scheme === "data") {
    // data: URLs are executable as text/html and navigable as href — images only, src only.
    return attr === "src" && /^data:image\//i.test(normalized);
  }
  return (attr === "href" ? SAFE_HREF_SCHEMES : SAFE_SRC_SCHEMES).has(scheme);
}

/**
 * CSS value filter for style attributes: drop declarations carrying exfil or
 * execution vectors (remote loads via url()/image-set, @import, script-ish
 * properties). Benign styling (colors, borders, alignment, fonts) survives.
 */
const CSS_DANGER = /url\s*\(|image-set\s*\(|expression\s*\(|@import|javascript:|behavior\s*:|binding\s*:|element\s*\(/i;

function sanitizeCssValue(val: string): string {
  return val
    .split(";")
    .filter((decl) => !CSS_DANGER.test(decl))
    .join(";");
}

function sanitizeHtml(html: string): string {
  if (!html || typeof html !== "string") return "";
  // Remove script, style (CSS url() exfil), comments, iframe, object; on* attrs.
  // Unterminated forms are stripped too — a closed pair is not required.
  let out = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<script\b[^>]*>/gi, "")
    .replace(/<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<style\b[^>]*>/gi, "")
    .replace(/<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!--/g, "")
    .replace(/<iframe\b[\s\S]*?(?:<\/iframe>|$)/gi, "")
    .replace(/<object\b[\s\S]*?(?:<\/object>|$)/gi, "")
    .replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, "")
    .replace(/\s+on\w+\s*=\s*[^\s>]+/gi, "");
  // We allow only the listed tags; for SVG we preserve case (linearGradient, clipPath).
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  out = out.replace(tagRe, (match) => {
    const open = match.startsWith("</");
    const namePart = match.slice(open ? 2 : 1);
    const firstSpace = namePart.search(/\s/);
    const gt = namePart.indexOf(">");
    const nameLen = firstSpace === -1 ? (gt === -1 ? namePart.length : gt) : firstSpace;
    const originalName = namePart.slice(0, nameLen).replace(/\/$/, "").trim();
    const name = originalName.toLowerCase();
    if (!ALLOWED_HTML_TAGS.has(name)) return "";
    const attrs = ALLOWED_ATTRS_LOWER[name] ?? DEFAULT_ALLOWED_ATTRS_LOWER;
    if (open) return `</${originalName}>`;
    const closeSlash = /\/\s*$/.test(match.slice(1, -1).trim()); // self-closing <rect ... />
    const attrPart = match.slice(1 + originalName.length, -1).trim();
    const kept: string[] = [];
    const attrRe = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*["']([^"']*)["']/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(attrPart)) !== null) {
      const attrName = m[1];
      const attr = attrName.toLowerCase();
      if (attr.startsWith("on")) continue;
      if (attrs.has(attr)) {
        let val = m[2];
        if (attr === "style") {
          val = sanitizeCssValue(val);
          if (!val.trim()) continue;
        }
        val = val.replace(/"/g, "&quot;");
        // href/src judged the way the browser will resolve them (entity/whitespace aware)
        if ((attr === "href" || attr === "src") && !isSafeUrlTarget(val, attr)) continue;
        // Original casing: SVG attributes are case-sensitive (viewBox, viewBox…).
        kept.push(`${attrName}="${val}"`);
      }
    }
    if (name === "a") {
      const hasTarget = kept.some((a) => a.toLowerCase().startsWith("target="));
      const hasRel = kept.some((a) => a.toLowerCase().startsWith("rel="));
      if (!hasTarget) kept.push('target="_blank"');
      if (!hasRel) kept.push('rel="noopener noreferrer"');
    }
    const openTag = `<${originalName}${kept.length ? " " + kept.join(" ") : ""}`;
    return closeSlash ? `${openTag} />` : `${openTag}>`;
  });
  return out.trim();
}

/**
 * Re-sanitize an already-parsed html cell body. Cells stored before a
 * sanitizer fix keep their stored (already-sanitized) bodies in the DB —
 * running the current sanitizer over them again drops schemes that were
 * passable back then. Idempotent on sanitizer output.
 */
export function sanitizeCellHtmlContent(html: string): string {
  return sanitizeHtml(html);
}
