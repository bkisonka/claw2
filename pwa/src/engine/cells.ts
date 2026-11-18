/**
 * Inline cells — mobile port of src/core/cell-blocks.ts.
 * The model writes [CELL type="html|chart|image|audio|video"]...[/CELL] blocks
 * into its response; we replace them with [CELL_N] placeholders and a cells
 * array, which the chat UI renders inline (markdown renderer path in Chat.tsx).
 *
 * Rewritten to survive real model output (the old port only matched perfectly
 * formed closed blocks and dumped raw markup otherwise):
 *  - tolerant closers: [/CELL], [/CELL ], [/cell], </CELL>, even truncated
 *    "[/CELL" / "</CELL" without the final bracket;
 *  - unclosed blocks are recovered: html closes after the last </table>/<svg>/
 *    </div>/</ul>/</ol>, media closes at end of line when the URL is complete,
 *    chart runs to the next cell or end of message;
 *  - HTML cell bodies pass an allowlist sanitizer before they reach
 *    dangerouslySetInnerHTML (the WebView exposes the Capacitor bridge);
 *  - stray [CELL_N] literals echoed by the model are stripped so they cannot
 *    collide with generated placeholders.
 */

export type ParsedCell = { type: string; content: string };

/** Opening tag: [CELL type="html"] — also bare [CELL] and extra attrs. */
const OPENER_RE =
  /\[CELL(?![\w])(?:\s+type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s\]"']+))?)?((?:\s+[^\]]*)?)\]/gi;

const MEDIA_TYPES = new Set(["image", "audio", "video"]);

/** Closing needle variants, earliest wins; longer variant preferred at same index. */
const CLOSE_NEEDLES: ReadonlyArray<readonly [string, number]> = [
  ["[/cell]", 7],
  ["</cell>", 7],
  ["[/cell", 6],
  ["</cell", 6],
];

function findCellEnd(text: string, from: number): { index: number; end: number } | null {
  const lower = text.toLowerCase();
  let best: { index: number; end: number } | null = null;
  for (const [needle, len] of CLOSE_NEEDLES) {
    const idx = lower.indexOf(needle, from);
    if (idx === -1) continue;
    if (best !== null && (idx > best.index || (idx === best.index && best.end - best.index >= len))) continue;
    best = { index: idx, end: idx + len };
  }
  if (best && /^[\s]*\]/.test(text.slice(best.end))) best.end += text.slice(best.end).indexOf("]") + 1;
  return best;
}

/** Strip trailing close-tag junk models leave on cell bodies (`[/CELL`, `]`, …). */
function stripTrailingCellClose(body: string): string {
  return body
    .replace(/\s*(?:\[\/CELL\]?|<\/CELL\]?)\s*$/i, "")
    .replace(/\s*\]\s*$/, "")
    .trim();
}

function stripFences(body: string): string {
  const trimmed = body.trim();
  const fenced = trimmed.match(/^```(?:html|json|svg)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fenced) return fenced[1].trim();
  return trimmed.replace(/^\s*```(?:html|json|svg)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
}

/** Media cells: http(s), data:, blob: and session file refs (/files/raw/<id>). */
function sanitizeMediaUrl(url: string): string | null {
  const t = url.trim().replace(/^!\[[^\]]*\]\(([^)\s]+)\)\s*$/, "$1");
  if (/^(https?:|data:|blob:)/i.test(t)) return t;
  if (/^\/files\/(raw\/)?file_/i.test(t)) return t;
  return null;
}

/** Complete enough to render without a 404 flash on a cropped stream. */
function isCompleteMediaBody(body: string): boolean {
  const url = sanitizeMediaUrl(body);
  if (!url) return false;
  if (/^(data:|blob:)/i.test(url)) return true;
  if (/^\/files\//i.test(url)) return true;
  try {
    return new URL(url).pathname.length > 1;
  } catch {
    return false;
  }
}

/**
 * If the model has not closed [/CELL], guess where the body ends (desktop
 * parity, src/core/cell-blocks.ts inferCellBodyEnd). Returns end index or -1
 * when no plausible cell body exists (opener stays literal text).
 */
function inferCellBodyEnd(text: string, from: number, type: string): number {
  OPENER_RE.lastIndex = from;
  const next = OPENER_RE.exec(text);
  const regionEnd = next ? next.index : text.length;

  if (type === "html") {
    const slice = text.slice(from, regionEnd);
    const closeTags = ["</table>", "</svg>", "</div>", "</ul>", "</ol>"];
    let best = -1;
    const lowerSlice = slice.toLowerCase();
    for (const tag of closeTags) {
      const idx = lowerSlice.lastIndexOf(tag);
      if (idx !== -1) best = Math.max(best, from + idx + tag.length);
    }
    if (best !== -1) return best;
    return /<[a-z][\s\S]*?>/i.test(slice) ? regionEnd : -1;
  }

  if (MEDIA_TYPES.has(type)) {
    const nl = text.indexOf("\n", from);
    const end = Math.min(nl === -1 ? text.length : nl, regionEnd);
    return isCompleteMediaBody(stripTrailingCellClose(text.slice(from, end))) ? end : -1;
  }

  // chart (and any other known type): runs to the next cell or end of message
  return regionEnd > from ? regionEnd : -1;
}

/* ---------- HTML sanitizer (allowlist port from desktop) ---------- */

const ALLOWED_TAGS = new Set([
  "div", "span", "p", "br", "table", "thead", "tbody", "tfoot", "colgroup", "col", "caption", "tr", "th", "td",
  "ul", "ol", "li", "h1", "h2", "h3", "h4", "strong", "em", "b", "i",
  "svg", "path", "circle", "rect", "line", "ellipse", "polygon", "polyline",
  "g", "text", "tspan", "title", "defs", "use", "lineargradient", "radialgradient", "stop", "clippath",
  "a", "img",
]);
const SVG_ATTRS = new Set([
  "class", "style", "id", "transform", "fill", "stroke", "stroke-width", "stroke-linecap",
  "stroke-linejoin", "stroke-dasharray", "fill-opacity", "stroke-opacity", "opacity",
]);
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel"]),
  img: new Set(["src", "alt", "width", "height"]),
  svg: new Set(["viewBox", "width", "height", "xmlns", "preserveAspectRatio", "class", "style"]),
  path: new Set([...SVG_ATTRS, "d"]),
  circle: new Set([...SVG_ATTRS, "cx", "cy", "r"]),
  rect: new Set([...SVG_ATTRS, "x", "y", "width", "height", "rx", "ry"]),
  line: new Set([...SVG_ATTRS, "x1", "y1", "x2", "y2"]),
  ellipse: new Set([...SVG_ATTRS, "cx", "cy", "rx", "ry"]),
  polygon: new Set([...SVG_ATTRS, "points"]),
  polyline: new Set([...SVG_ATTRS, "points"]),
  g: new Set(SVG_ATTRS),
  text: new Set([...SVG_ATTRS, "x", "y", "dx", "dy", "text-anchor", "font-size", "font-family"]),
  tspan: new Set([...SVG_ATTRS, "x", "y", "dx", "dy"]),
  defs: new Set(["id"]),
  use: new Set(["href", "x", "y", "width", "height"]),
  lineargradient: new Set(["id", "x1", "y1", "gradientunits"]),
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
};
const DEFAULT_ATTRS = new Set(["class", "style", "id"]);

/** Lowercased attr names for the allowlist check; original casing is kept on output. */
const ALLOWED_ATTRS_LOWER: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(ALLOWED_ATTRS).map(([tag, set]) => [tag, new Set([...set].map((a) => a.toLowerCase()))])
);
const DEFAULT_ATTRS_LOWER = new Set([...DEFAULT_ATTRS].map((a) => a.toLowerCase()));

/* ---------- URL scheme allowlist (href/src) ---------- */

/**
 * The scheme of a link must be judged the way the BROWSER will judge it, not
 * the way the raw attribute reads: the HTML parser decodes character references
 * ("&#106;avascript:" → "javascript:") and the URL parser strips tab/LF/CR from
 * anywhere inside the URL ("jav\tascript:" → "javascript:"). A raw-prefix check
 * misses both (audited 2026-10). This decoder is deterministic (no DOM), so it
 * behaves identically in the app and in Node tests.
 */

/**
 * Named refs whose values can contribute ASCII to a scheme prefix. Keys are
 * CASE-SENSITIVE, matching the HTML5 named-reference list exactly ("&Tab;",
 * "&NewLine;", "&Hat;" are capitalized; "&tab;" / "&newline;" do not exist).
 * No HTML5 named ref yields an ASCII letter, so letters can only arrive via
 * numeric refs, which the decoder resolves fully.
 */
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
  if (!html) return "";
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
  out = out.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (match) => {
    const open = match.startsWith("</");
    const namePart = match.slice(open ? 2 : 1);
    const firstSpace = namePart.search(/\s/);
    const gt = namePart.indexOf(">");
    const nameLen = firstSpace === -1 ? (gt === -1 ? namePart.length : gt) : firstSpace;
    const originalName = namePart.slice(0, nameLen).replace(/\/$/, "").trim();
    const name = originalName.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return "";
    const attrs = ALLOWED_ATTRS_LOWER[name] ?? DEFAULT_ATTRS_LOWER;
    if (open) return `</${originalName}>`;
    const closeSlash = /\/\s*$/.test(match.slice(1, -1).trim());
    const attrPart = match.slice(1 + originalName.length, -1).trim();
    const kept: string[] = [];
    const attrRe = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*["']([^"']*)["']/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(attrPart)) !== null) {
      const attrName = m[1];
      const attr = attrName.toLowerCase();
      if (attr.startsWith("on")) continue;
      if (!attrs.has(attr)) continue;
      let val = m[2];
      if (attr === "style") {
        val = sanitizeCssValue(val);
        if (!val.trim()) continue;
      }
      val = val.replace(/"/g, "&quot;");
      if ((attr === "href" || attr === "src") && !isSafeUrlTarget(val, attr)) continue;
      kept.push(`${attrName}="${val}"`);
    }
    if (name === "a") {
      if (!kept.some((a) => a.startsWith("target="))) kept.push('target="_blank"');
      if (!kept.some((a) => a.startsWith("rel="))) kept.push('rel="noopener noreferrer"');
    }
    const tag = `<${originalName}${kept.length ? " " + kept.join(" ") : ""}`;
    return closeSlash ? `${tag} />` : `${tag}>`;
  });
  return out.trim();
}

/**
 * Public re-sanitize pass for HTML cells at render time. Cells stored before a
 * sanitizer fix keep their stored (already-sanitized) bodies in IndexedDB —
 * running the current sanitizer over them again drops schemes that were
 * passable back then. The pass is idempotent on sanitizer output (all attrs
 * quoted, tags allowlisted, a:href scheme-checked again).
 */
export function sanitizeCellHtml(html: string): string {
  return sanitizeHtml(html);
}

/* ---------- scanning ---------- */

type RawBlock = { start: number; end: number; type: string; body: string };

/** Find all cell blocks (closed, or recovered when the model forgot [/CELL]). */
function scanBlocks(text: string): { blocks: RawBlock[]; skipped: number[] } {
  const blocks: RawBlock[] = [];
  const skipped: number[] = [];
  OPENER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OPENER_RE.exec(text)) !== null) {
    const type = (m[1] ?? m[2] ?? m[3] ?? "html").toString().trim().toLowerCase() || "html";
    const afterStart = m.index + m[0].length;
    const explicitEnd = findCellEnd(text, afterStart);
    OPENER_RE.lastIndex = afterStart;
    const nextOpener = OPENER_RE.exec(text);
    const nextOpenerIdx = nextOpener ? nextOpener.index : text.length;

    if (explicitEnd && explicitEnd.index <= nextOpenerIdx) {
      blocks.push({ start: m.index, end: explicitEnd.end, type, body: text.slice(afterStart, explicitEnd.index).trim() });
      OPENER_RE.lastIndex = explicitEnd.end;
    } else {
      const inferred = inferCellBodyEnd(text, afterStart, type);
      if (inferred === -1) {
        skipped.push(m.index); // no plausible body: opener stays literal
        OPENER_RE.lastIndex = afterStart;
        continue;
      }
      blocks.push({ start: m.index, end: inferred, type, body: stripTrailingCellClose(text.slice(afterStart, inferred)) });
      OPENER_RE.lastIndex = inferred;
    }
  }
  return { blocks, skipped };
}

function blockToCell(block: RawBlock): ParsedCell | null {
  if (block.type === "html") return { type: "html", content: sanitizeHtml(stripFences(block.body)) };
  if (block.type === "chart") return { type: "chart", content: stripFences(block.body) };
  if (MEDIA_TYPES.has(block.type)) {
    const url = sanitizeMediaUrl(stripTrailingCellClose(block.body));
    return url ? { type: block.type, content: url } : null; // broken media → drop block
  }
  return null; // unknown type → hide markup
}

export function parseCellBlocks(text: string): { text: string; cells: ParsedCell[] } {
  const cells: ParsedCell[] = [];
  if (!text || !/\[CELL/i.test(text)) return { text, cells };
  // Note: model-echoed [CELL_N] placeholders are NOT stripped here — that would
  // break re-parsing of already-parsed content. An echo may re-render a cell;
  // the system prompt forbids echoes.
  const source = text;
  const { blocks, skipped } = scanBlocks(source);
  if (!blocks.length && !skipped.length) return { text: source, cells };
  const pieces: string[] = [];
  let cursor = 0;
  const marks = [...blocks.map((b) => ({ pos: b.start, block: b })), ...skipped.map((pos) => ({ pos, block: null }))]
    .sort((a, b) => a.pos - b.pos);
  for (const mark of marks) {
    pieces.push(source.slice(cursor, mark.pos));
    if (mark.block) {
      const cell = blockToCell(mark.block);
      if (cell) {
        pieces.push(`[CELL_${cells.length}]`);
        cells.push(cell);
      }
      cursor = mark.block.end;
    } else {
      // unrecoverable opener: hide the raw token, keep following text flowing
      OPENER_RE.lastIndex = mark.pos;
      const m = OPENER_RE.exec(source);
      cursor = mark.pos + (m ? m[0].length : 0);
    }
  }
  pieces.push(source.slice(cursor));
  return { text: pieces.join(""), cells };
}

/**
 * Streaming view: split the (possibly partial) buffer into already-closed cells
 * and a trailing fragment. Closed cells render as blocks immediately; the open
 * tail is hidden until its [/CELL] arrives (recovery to EOF happens only at
 * message finalize — mid-stream we cannot know where the body ends).
 */
export function splitClosedCells(text: string): {
  visible: string;
  cells: ParsedCell[];
  tail: string;
} {
  if (!text || !/\[CELL/i.test(text)) return { visible: text, cells: [], tail: "" };
  const cells: ParsedCell[] = [];
  const pieces: string[] = [];
  let cursor = 0;
  OPENER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OPENER_RE.exec(text)) !== null) {
    const type = (m[1] ?? m[2] ?? m[3] ?? "html").toString().trim().toLowerCase() || "html";
    const afterStart = m.index + m[0].length;
    const explicitEnd = findCellEnd(text, afterStart);
    OPENER_RE.lastIndex = afterStart;
    const nextOpener = OPENER_RE.exec(text);
    const nextOpenerIdx = nextOpener ? nextOpener.index : text.length;
    const closed = explicitEnd !== null && explicitEnd.index <= nextOpenerIdx;

    if (!closed) {
      // open tail: hide the raw markup from the user until finalize
      pieces.push(text.slice(cursor, m.index));
      return { visible: pieces.join(""), cells, tail: text.slice(m.index) };
    }
    pieces.push(text.slice(cursor, m.index));
    const cell = blockToCell({ start: m.index, end: explicitEnd.end, type, body: text.slice(afterStart, explicitEnd.index).trim() });
    if (cell) {
      pieces.push(`[CELL_${cells.length}]`);
      cells.push(cell);
    }
    cursor = explicitEnd.end;
    OPENER_RE.lastIndex = explicitEnd.end;
  }
  pieces.push(text.slice(cursor));
  return { visible: pieces.join(""), cells, tail: "" };
}

/** UI text → plain text (notifications, titles, search). */
export function stripCellPlaceholders(text: string): string {
  return text
    .replace(/\[CELL_\d+\]/g, "")
    .replace(/\[CELL[^\]]*\][\s\S]*?(?:\[\/\s*CELL\s*\]|<\/\s*CELL\s*>|\[\/CELL$|<\/CELL$)/gi, "")
    .trim();
}
