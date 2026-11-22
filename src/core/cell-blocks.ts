// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Parsing [CELL type="..."]...[/CELL] blocks in the model response for inline insertion into chat (calendars, charts, HTML).
 * Result: text with placeholders [CELL_0], [CELL_1], ... and an array of cells for substitution at the front.
 */

import { stripHssEpistemicFooter } from "../claw-cache/hss-epistemic-hint.js";

export interface ParsedCell {
  type: string;
  content: string;
}

/** Opening tag: [CELL type="html"]... also allows extra attributes: [CELL type="image" alt="..."].*/
const CELL_START_RE =
  /\[CELL\s+type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s\]"']+))(?:\s+[^\]]*)?\]/gis;
/** Strip trailing close-tag junk models leave on media URLs (`[/CELL`, `[/CELL]`, …). */
function stripTrailingCellClose(body: string): string {
  return body
    .replace(/\s*(?:\[\/CELL\]?|<\/CELL\]?)\s*$/i, "")
    .trim();
}

function findCellEnd(text: string, from: number): { index: number; length: number } | null {
  const lower = text.toLowerCase();
  let best: { index: number; length: number } | null = null;
  // Full closers first; then truncated `[/CELL` / `</CELL` (missing final `]`).
  for (const [needle, len] of [
    ["[/cell]", 7],
    ["</cell>", 7],
    ["[/cell", 6],
    ["</cell", 6],
  ] as const) {
    const idx = lower.indexOf(needle, from);
    if (idx === -1) continue;
    // Prefer longer match at the same index (`[/cell]` over `[/cell`).
    if (best !== null && best.index === idx && best.length >= len) continue;
    if (best === null || idx < best.index) {
      best = { index: idx, length: len };
    }
  }
  return best;
}

/** If the model has not closed [/CELL], we guess the end of the cell body.*/
function inferCellBodyEnd(text: string, from: number, type: string): number {
  const lower = text.toLowerCase();
  const nextCell = lower.indexOf("[cell", from);
  const regionEnd = nextCell === -1 ? text.length : nextCell;

  if (type === "html") {
    const slice = text.slice(from, regionEnd);
    const closeTags = ["</table>", "</svg>", "</div>", "</ul>", "</ol>"];
    let best = -1;
    for (const tag of closeTags) {
      const idx = slice.toLowerCase().lastIndexOf(tag);
      if (idx !== -1) {
        const end = from + idx + tag.length;
        if (end > best) best = end;
      }
    }
    if (best !== -1) return best;
    if (/<[a-z][\s\S]*?>/i.test(slice)) return regionEnd;
    return -1;
  }

  if (MEDIA_CELL_TYPES.has(type)) {
    const nl = text.indexOf("\n", from);
    const lineEnd = nl === -1 ? text.length : nl;
    const end = Math.min(lineEnd, regionEnd);
    const body = text.slice(from, end).trim();
    // While the URL is without an extension / incomplete, do not close the cell (stream), otherwise the img will get 404.
    if (!isCompleteMediaBody(body, type)) return -1;
    return end;
  }

  if (type === "chart") return regionEnd;
  return regionEnd;
}

function stripMarkdownFences(body: string): string {
  const trimmed = body.trim();
  const fenced = trimmed.match(/^```(?:html)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fenced) return fenced[1].trim();
  return trimmed.replace(/^\s*```(?:html)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
}

/** Types of cells with media URL: tag body - one URL, checked by sanitization.*/
const MEDIA_CELL_TYPES = new Set(["audio", "video", "image"]);
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const AUDIO_EXT_RE = /\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i;
const VIDEO_EXT_RE = /\.(mp4|mov|mkv|webm|ogv)$/i;
const SAFE_BASENAME_RE = /^[a-zA-Z0-9._-]+$/;

/** The body of the media cell is full enough so as not to pull img/audio on a cropped stream.*/
function isCompleteMediaBody(body: string, type: string): boolean {
  const trimmed = stripTrailingCellClose(body);
  if (!trimmed) return false;
  const mdImg = trimmed.match(/^!\[[^\]]*\]\(([^)\s]+)\)\s*$/);
  const url = stripTrailingCellClose(mdImg ? mdImg[1] : trimmed);
  if (/^https?:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      return u.pathname.length > 1;
    } catch {
      return false;
    }
  }
  if (type === "image") return IMAGE_EXT_RE.test(url);
  if (type === "audio") return AUDIO_EXT_RE.test(url) || /^https?:\/\//i.test(url);
  if (type === "video") return VIDEO_EXT_RE.test(url) || /^https?:\/\//i.test(url);
  return false;
}

/**
 * Checks the URL for audio/video/image cells: http/https or (for image only) the path /files/...
 * Bare filename (f22.jpg) → /files/output/f22.jpg (agents write to agents/output).
 * Returns trim URL or null if the schema is invalid.
 */
function sanitizeMediaUrl(url: string, cellType?: string): string | null {
  if (!url || typeof url !== "string") return null;
  let trimmed = stripTrailingCellClose(url);
  if (!trimmed) return null;

  // The model often wraps the URL in backticks/angle brackets
  trimmed = trimmed.replace(/^`+|`+$/g, "").trim();
  trimmed = trimmed.replace(/^<|>$/g, "").trim();
  trimmed = trimmed.replace(/^["']|["']$/g, "").trim();
  trimmed = stripTrailingCellClose(trimmed);
  if (!trimmed) return null;

  // The model sometimes puts a markdown image inside the CELL
  const mdImg = trimmed.match(/^!\[[^\]]*\]\(([^)\s]+)\)\s*$/);
  if (mdImg) trimmed = mdImg[1].trim();

  const lower = trimmed.toLowerCase();
  if (lower.startsWith("https://") || lower.startsWith("http://")) return trimmed;

  if (cellType === "image" || cellType === "audio" || cellType === "video") {
    // files/output/foo.jpg (without leading /)
    const filesRel = trimmed.match(/^files\/(output|uploads)\/([^/\\]+)$/i);
    if (filesRel && SAFE_BASENAME_RE.test(filesRel[2])) {
      return `/files/${filesRel[1].toLowerCase()}/${filesRel[2]}`;
    }
    // agents/output/foo.jpg → /files/output/foo.jpg
    const agentsOut = trimmed.match(/^agents\/output\/([^/\\]+)$/i);
    if (agentsOut && SAFE_BASENAME_RE.test(agentsOut[1])) {
      return `/files/output/${agentsOut[1]}`;
    }
    // /files/agents/output/foo.jpg - a common model error (path as on disk)
    const filesAgentsOut = trimmed.match(/^\/files\/agents\/output\/([^/\\]+)$/i);
    if (filesAgentsOut && SAFE_BASENAME_RE.test(filesAgentsOut[1])) {
      return `/files/output/${filesAgentsOut[1]}`;
    }
    // already /files/output/... or /files/uploads/...
    if (trimmed.startsWith("/") && !trimmed.includes("..")) {
      // absolute path on disk not media URL
      if (/^\/(?:Users|home|var|tmp|private)\b/i.test(trimmed)) return null;
      if (cellType === "image" && !IMAGE_EXT_RE.test(trimmed)) return null;
      if (cellType === "audio" && !AUDIO_EXT_RE.test(trimmed) && !/\.webm$/i.test(trimmed)) return null;
      if (cellType === "video" && !VIDEO_EXT_RE.test(trimmed)) return null;
      // only /files/... for local paths
      if (trimmed.startsWith("/files/")) return trimmed;
      return null;
    }
    // bare name: f22_raptor.jpg
    if (SAFE_BASENAME_RE.test(trimmed) && IMAGE_EXT_RE.test(trimmed) && cellType === "image") {
      return `/files/output/${trimmed}`;
    }
    if (
      SAFE_BASENAME_RE.test(trimmed) &&
      /\.(mp3|wav|ogg|m4a|aac|flac|webm|mp4|mov|mkv)$/i.test(trimmed) &&
      (cellType === "audio" || cellType === "video")
    ) {
      return `/files/output/${trimmed}`;
    }
  }
  return null;
}

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

export interface ParseCellBlocksResult {
  /** Text with placeholders [CELL_0], [CELL_1], ...*/
  content: string;
  cells: ParsedCell[];
}

export function cellsToMeta(cells: ParsedCell[]): string | undefined {
  if (!cells.length) return undefined;
  return JSON.stringify({ cells });
}

export function cellsFromMeta(meta: string | undefined): ParsedCell[] | undefined {
  if (!meta) return undefined;
  try {
    const parsed = JSON.parse(meta) as { cells?: ParsedCell[] };
    if (Array.isArray(parsed.cells) && parsed.cells.length > 0) return parsed.cells;
  } catch {
    // ignore invalid meta
  }
  return undefined;
}

/** Reverse operation for LLM context: [CELL_0] → [CELL type="html"]...[/CELL].
 * Image cells do not reveal the real URL - otherwise the model copies generated-....png without generate_image.
 */
export function expandCellPlaceholders(content: string, cells: ParsedCell[]): string {
  if (!content || !cells.length) return content;
  return content.replace(/\[CELL_(\d+)\]/g, (match, n) => {
    const i = Number.parseInt(n, 10);
    const cell = cells[i];
    if (!cell) return match;
    if (cell.type === "image" || cell.type === "image_deleted") {
      return `[CELL type="image"](previous image in this chat — for edits call generate_image with image=/files/output/…; do not invent paths)[/CELL]`;
    }
    return `[CELL type="${cell.type}"]${cell.content}[/CELL]`;
  });
}

/** Removes placeholders without corresponding cells (model hallucinations).*/
export function stripOrphanCellPlaceholders(content: string): string {
  if (!content) return content;
  return content
    .replace(/\[CELL_\d+\]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Assistant message text for submission to LLM.
 * In the database/UI - placeholders [CELL_N] + meta; for LLM, expand html/audio/…,
 * image - without real path (see expandCellPlaceholders).
 */
export function contentForLlmHistory(content: string, meta?: string): string {
  const cleaned = stripHssEpistemicFooter(content);
  const cells = cellsFromMeta(meta);
  if (cells?.length) return expandCellPlaceholders(cleaned, cells);
  if (/\[CELL_\d+\]/.test(cleaned)) return stripOrphanCellPlaceholders(cleaned);
  return cleaned;
}

/** Restores cells for API/history: meta → parsing raw [CELL] into content.*/
export function resolveAssistantCells(
  content: string,
  meta?: string
): { content: string; cells: ParsedCell[] } {
  const cleaned = stripHssEpistemicFooter(content);
  const fromMeta = cellsFromMeta(meta);
  if (fromMeta?.length) return { content: cleaned, cells: fromMeta };
  const parsed = parseCellBlocks(cleaned);
  if (parsed.cells.length > 0) return parsed;
  // Naked [CELL_N] without meta - do not show as text
  if (/\[CELL_\d+\]/.test(cleaned)) {
    return { content: stripOrphanCellPlaceholders(cleaned), cells: [] };
  }
  return { content: cleaned, cells: [] };
}

export function parseCellBlocks(text: string): ParseCellBlocksResult {
  if (!text || typeof text !== "string") return { content: text, cells: [] };
  const replacements: { start: number; end: number; type: string; body: string }[] = [];
  CELL_START_RE.lastIndex = 0;
  let startMatch: RegExpExecArray | null;
  while ((startMatch = CELL_START_RE.exec(text)) !== null) {
    const type = (startMatch[1] ?? startMatch[2] ?? startMatch[3] ?? "").toLowerCase().trim();
    const afterStart = startMatch.index + startMatch[0].length;
    const explicitEnd = findCellEnd(text, afterStart);
    let endPos: number;
    if (explicitEnd) {
      endPos = explicitEnd.index + explicitEnd.length;
    } else {
      const inferredEnd = inferCellBodyEnd(text, afterStart, type);
      if (inferredEnd === -1) continue;
      endPos = inferredEnd;
    }
    let body = text.slice(afterStart, explicitEnd ? explicitEnd.index : endPos).trim();
    if (MEDIA_CELL_TYPES.has(type)) body = stripTrailingCellClose(body);
    if (!type) continue;
    replacements.push({
      start: startMatch.index,
      end: endPos,
      type,
      body,
    });
  }
  // We collect the result from the end. Invalid media URLs do not become empty cells
  // (otherwise the UI shows "Link failed validation" and the valid [CELL_1] is lost).
  type Applied = { start: number; end: number; replacement: string; cell?: ParsedCell };
  const applied: Applied[] = [];
  for (const r of replacements) {
    if (r.type === "html") {
      applied.push({
        start: r.start,
        end: r.end,
        replacement: "", // placeholder assigned after filter
        cell: { type: r.type, content: sanitizeHtml(stripMarkdownFences(r.body)) },
      });
      continue;
    }
    if (MEDIA_CELL_TYPES.has(r.type)) {
      const sanitized = sanitizeMediaUrl(r.body, r.type);
      if (!sanitized) {
        // Remove a broken block from text - without an empty image cell
        applied.push({ start: r.start, end: r.end, replacement: "" });
        continue;
      }
      applied.push({
        start: r.start,
        end: r.end,
        replacement: "",
        cell: { type: r.type, content: sanitized },
      });
      continue;
    }
    applied.push({
      start: r.start,
      end: r.end,
      replacement: "",
      cell: { type: r.type, content: r.body },
    });
  }

  const cells: ParsedCell[] = [];
  let cellIdx = 0;
  for (const a of applied) {
    if (a.cell) {
      a.replacement = `[CELL_${cellIdx}]`;
      cells.push(a.cell);
      cellIdx += 1;
    }
  }

  let resultContent = text;
  for (let i = applied.length - 1; i >= 0; i--) {
    const a = applied[i];
    resultContent = resultContent.slice(0, a.start) + a.replacement + resultContent.slice(a.end);
  }
  return { content: resultContent, cells };
}
