import { describe, expect, it } from "vitest";
import { parseCellBlocks, sanitizeCellHtml, splitClosedCells, stripCellPlaceholders, type ParsedCell } from "./cells";

const cellOf = (c: ParsedCell[]) => c[0];

describe("parseCellBlocks: closed blocks", () => {
  it("returns text untouched when there are no cells", () => {
    const t = "Обычный ответ без блоков.";
    expect(parseCellBlocks(t)).toEqual({ text: t, cells: [] });
  });

  it("parses a simple closed html cell", () => {
    const { text, cells } = parseCellBlocks('До [CELL type="html"]<p>привет</p>[/CELL] После');
    expect(text).toBe("До [CELL_0] После");
    expect(cells).toHaveLength(1);
    expect(cellOf(cells).type).toBe("html");
    expect(cellOf(cells).content).toBe("<p>привет</p>");
  });

  it("accepts quoted, single-quoted, unquoted and uppercase types", () => {
    for (const opener of ['[CELL type="html"]', "[CELL type='html']", "[CELL type=html]", "[cell TYPE=HTML]"]) {
      const { text, cells } = parseCellBlocks(`${opener}x[/CELL]`);
      expect(text).toBe("[CELL_0]");
      expect(cells[0].type).toBe("html");
    }
  });

  it("accepts a bare [CELL] and extra attributes", () => {
    expect(parseCellBlocks("[CELL]<b>1</b>[/CELL]").cells[0].type).toBe("html");
    const { cells } = parseCellBlocks('[CELL type="image" alt="кот"]https://x/cat.png[/CELL]');
    expect(cells[0]).toEqual({ type: "image", content: "https://x/cat.png" });
  });

  it("numbers placeholders in order and preserves surrounding text", () => {
    const { text, cells } = parseCellBlocks(
      'a[CELL type="html"]<i>1</i>[/CELL]b[CELL type="chart"]{"series":[]}[/CELL]c'
    );
    expect(text).toBe("a[CELL_0]b[CELL_1]c");
    expect(cells.map((c) => c.type)).toEqual(["html", "chart"]);
  });

  it("strips markdown fences inside html and chart bodies", () => {
    const { cells } = parseCellBlocks('[CELL type="html"]```html\n<table>...</table>\n```[/CELL]');
    expect(cells[0].content).toBe("<table>...</table>");
    const { cells: c2 } = parseCellBlocks('[CELL type="chart"]```json\n{"series":[]}\n```[/CELL]');
    expect(c2[0].content).toBe('{"series":[]}');
  });

  it("handles multiline bodies and CRLF", () => {
    const { cells } = parseCellBlocks('[CELL type="html"]<div>\r\n<span>строка</span>\r\n</div>[/CELL]');
    expect(cells[0].content).toBe("<div>\r\n<span>строка</span>\r\n</div>");
  });

  it("hides unknown-type blocks but keeps the rest of the text", () => {
    const { text, cells } = parseCellBlocks('До [CELL type="foo"]секрет[/CELL] после');
    expect(text).toBe("До  после");
    expect(cells).toHaveLength(0);
    expect(text).not.toContain("секрет");
  });
});

describe("parseCellBlocks: media cells", () => {
  it.each([
    ["https://example.com/a.png", "https://example.com/a.png"],
    ["![кот](https://example.com/a.png)", "https://example.com/a.png"],
    ["data:image/png;base64,AAAA", "data:image/png;base64,AAAA"],
    ["/files/raw/file_abc", "/files/raw/file_abc"],
  ])("accepts %s", (body, expected) => {
    expect(parseCellBlocks(`[CELL type="image"]${body}[/CELL]`).cells[0].content).toBe(expected);
  });

  it("drops media cells with invalid URLs entirely", () => {
    const { text, cells } = parseCellBlocks('До [CELL type="image"]javascript:alert(1)[/CELL] после');
    expect(text).toBe("До  после");
    expect(cells).toHaveLength(0);
  });

  it("strips junk a model leaves after the URL", () => {
    expect(parseCellBlocks('[CELL type="image"]https://x/a.png [/CELL]').cells[0].content).toBe("https://x/a.png");
  });
});

describe("parseCellBlocks: tolerant closers", () => {
  it.each([
    "[/CELL]",
    "[/cell]",
    "[/Cell ]",
    "</CELL>",
    "</cell>",
    "[/CELL",
    "</CELL",
  ])("accepts closer %s", (closer) => {
    const { text, cells } = parseCellBlocks(`[CELL type="html"]<p>x</p>${closer} хвост`);
    expect(text).toBe("[CELL_0] хвост");
    expect(cells[0].content).toBe("<p>x</p>");
  });

  it("does not mistake a closer belonging to the next block", () => {
    const { text, cells } = parseCellBlocks(
      '[CELL type="chart"]{"a":1}[/CELL] [CELL type="chart"]{"b":2}[/CELL]'
    );
    expect(cells).toHaveLength(2);
    expect(text).toBe("[CELL_0] [CELL_1]");
  });
});

describe("parseCellBlocks: recovery of unclosed blocks (the screenshot bug)", () => {
  it("closes an html table before the prose that follows and keeps the prose", () => {
    const raw =
      'Считаем.\n\n[CELL type="html"]<table><tr><th>Машина</th><th>Самолёт</th></tr>' +
      "<tr><td>4 дня</td><td>≈1 день</td></tr></table>\n\n" +
      "Вот это и есть единственный настоящий аргумент: три дня вместо шести.";
    const { text, cells } = parseCellBlocks(raw);
    expect(cells).toHaveLength(1);
    expect(cells[0].type).toBe("html");
    expect(cells[0].content).toContain("<table>");
    expect(cells[0].content).toContain("</table>");
    expect(cells[0].content).not.toContain("аргумент");
    expect(text).toBe("Считаем.\n\n[CELL_0]\n\nВот это и есть единственный настоящий аргумент: три дня вместо шести.");
    expect(text).not.toContain("[CELL type=");
  });

  it("closes an unclosed svg after </svg>", () => {
    const { cells } = parseCellBlocks('[CELL type="html"]<svg><circle r="5"/></svg> и текст');
    expect(cells[0].content).toBe("<svg><circle r=\"5\" /></svg>");
  });

  it("runs an unclosed block to end of message when it is all markup", () => {
    const { cells } = parseCellBlocks('[CELL type="html"]<div><p>один</p><p>два</p>');
    expect(cells[0].content).toContain("<p>два</p>");
  });

  it("runs an unclosed chart to end of message", () => {
    const { cells } = parseCellBlocks('[CELL type="chart"]{"series":[{"type":"line"}]}');
    expect(cells[0].type).toBe("chart");
    expect(cells[0].content).toBe('{"series":[{"type":"line"}]}');
  });

  it("leaves a bare opener as literal text when the body has no markup at all", () => {
    const { text, cells } = parseCellBlocks("[CELL type=\"html\"] просто текст без тегов");
    expect(cells).toHaveLength(0);
    expect(text).toBe(" просто текст без тегов");
  });

  it("recovers a media cell closed by end of line with a complete URL", () => {
    const { text, cells } = parseCellBlocks('Кот: [CELL type="image"]https://x/cat.png\nИ текст дальше.');
    expect(cells[0].content).toBe("https://x/cat.png");
    expect(text).toBe("Кот: [CELL_0]\nИ текст дальше.");
  });

  it("does not recover an incomplete media URL (stream guard)", () => {
    const { text, cells } = parseCellBlocks('[CELL type="image"]https://x');
    expect(cells).toHaveLength(0);
    expect(text).toBe("https://x");
  });

  it("recovers several unclosed blocks independently", () => {
    const { text, cells } = parseCellBlocks(
      '[CELL type="html"]<ul><li>a</li></ul> текст1 [CELL type="html"]<ol><li>b</li></ol> текст2'
    );
    expect(cells).toHaveLength(2);
    expect(text).toBe("[CELL_0] текст1 [CELL_1] текст2");
  });
});

describe("parseCellBlocks: placeholder hygiene", () => {
  it("does not collide: generated placeholder indexes follow the cells array", () => {
    const { text, cells } = parseCellBlocks('[CELL type="html"]<b>x</b>[/CELL][CELL type="html"]<b>y</b>[/CELL]');
    expect(text).toBe("[CELL_0][CELL_1]");
    expect(cells.map((c) => c.content)).toEqual(["<b>x</b>", "<b>y</b>"]);
  });

  it("keeps model-echoed placeholders (documented: echo may re-render a cell)", () => {
    const { text, cells } = parseCellBlocks('эхо [CELL_0] [CELL type="html"]<b>x</b>[/CELL]');
    expect(cells).toHaveLength(1);
    expect(text).toBe("эхо [CELL_0] [CELL_0]");
  });

  it("is stable when applied to its own output", () => {
    const once = parseCellBlocks('До [CELL type="html"]<p>x</p>[/CELL] после');
    const twice = parseCellBlocks(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.cells).toHaveLength(0);
  });
});

describe("parseCellBlocks: html sanitization", () => {
  it("strips script tags and inline handlers", () => {
    const { cells } = parseCellBlocks(
      '[CELL type="html"]<p onclick="steal()">ok</p><script>alert(1)</script>[/CELL]'
    );
    expect(cells[0].content).toBe("<p>ok</p>");
    expect(cells[0].content).not.toContain("script");
    expect(cells[0].content).not.toContain("onclick");
  });

  it("drops javascript: hrefs and forces safe anchors", () => {
    const { cells } = parseCellBlocks('[CELL type="html"]<a href="javascript:alert(1)">x</a>[/CELL]');
    expect(cells[0].content).not.toContain("javascript:");
    expect(cells[0].content).toContain('target="_blank"');
    expect(cells[0].content).toContain('rel="noopener noreferrer"');
  });

  // Browser normalization: character references decode and tab/LF/CR vanish
  // from URLs, so a raw-prefix check is not enough (audited 2026-10).
  it.each([
    '<a href="&#106;avascript:alert(1)">x</a>',
    '<a href="jav\tascript:alert(1)">x</a>',
    '<a href="jav&#x0A;ascript:alert(1)">x</a>',
    '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a>',
    '<a href="&amp;#106;avascript:alert(1)">x</a>',
    '<a href="  javascript:alert(1)">x</a>',
    '<a href="JAVASCRIPT:alert(1)">x</a>',
    '<a href="vbscript:alert(1)">x</a>',
    '<a href="intent://scan#Intent;scheme=http;end">x</a>',
    '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>',
    '<a href="file:///etc/passwd">x</a>',
    '<img src="&#106;avascript:alert(1)">',
    '<a href="&Tab;javascript:alert(1)">x</a>',
    '<a href="&NewLine;javascript:alert(1)">x</a>',
    '<a href="j&#97;v&#97;script&#58;alert(1)">x</a>',
    '<a href="&#x26;#106;avascript:alert(1)">x</a>',
    '<a href="&#0000106;avascript:alert(1)">x</a>',
  ])("drops evasive url target %s", (body) => {
    const { cells } = parseCellBlocks(`[CELL type="html"]${body}[/CELL]`);
    const out = cells[0].content;
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toMatch(/vbscript:/i);
    expect(out).not.toContain("intent:");
    expect(out).not.toContain("data:text");
    expect(out).not.toContain("file:");
  });

  it("keeps a hex entity that the browser consumes greedily into a non-ascii codepoint", () => {
    // "&#x6Aa" is one numeric ref (U+06AA, not "j" + "a") — the decoded scheme
    // is not javascript:, the link survives as an unusable relative target.
    const { cells } = parseCellBlocks('[CELL type="html"]<a href="&#x6Aavascript:alert(1)">x</a>[/CELL]');
    expect(cells[0].content).toContain("&#x6Aavascript:");
  });

  it("keeps legitimate link and image targets", () => {
    const { cells } = parseCellBlocks(
      '[CELL type="html"]<a href="https://example.com/a?b=1">s</a><a href="/x">rel</a><a href="#sec">anc</a><a href="mailto:a@b.c">m</a><img src="data:image/png;base64,AAAA"><img src="/files/raw/file_abc">[/CELL]'
    );
    const out = cells[0].content;
    expect(out).toContain('href="https://example.com/a?b=1"');
    expect(out).toContain('href="/x"');
    expect(out).toContain('href="#sec"');
    expect(out).toContain('href="mailto:a@b.c"');
    expect(out).toContain('src="data:image/png;base64,AAAA"');
    expect(out).toContain('src="/files/raw/file_abc"');
  });

  it("re-sanitizing sanitizer output is stable and re-checks stored (pre-fix) bodies", () => {
    // A cell stored by an older app version with an evasive href still in it.
    const stored = '<a href="&#106;avascript:alert(1)" target="_blank" rel="noopener noreferrer">x</a>';
    const once = sanitizeCellHtml(stored);
    expect(once).not.toMatch(/javascript:/i);
    expect(sanitizeCellHtml(once)).toBe(once);
  });

  it("keeps allowlisted svg intact (attr names keep their casing)", () => {
    const svg = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#fff"/></svg>';
    expect(parseCellBlocks(`[CELL type="html"]${svg}[/CELL]`).cells[0].content).toBe(
      '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#fff" /></svg>'
    );
  });

  it("strips disallowed tags like iframe", () => {
    const { cells } = parseCellBlocks('[CELL type="html"]<iframe src="https://evil"></iframe><p>y</p>[/CELL]');
    expect(cells[0].content).toBe("<p>y</p>");
  });
});

describe("splitClosedCells (streaming)", () => {
  it("passes text without cells through", () => {
    expect(splitClosedCells("просто текст")).toEqual({ visible: "просто текст", cells: [], tail: "" });
  });

  it("renders closed cells and keeps text after them visible", () => {
    const r = splitClosedCells('До [CELL type="html"]<p>1</p>[/CELL] После');
    expect(r.visible).toBe("До [CELL_0] После");
    expect(r.cells).toHaveLength(1);
    expect(r.tail).toBe("");
  });

  it("hides an open tail from the opener and returns it as tail", () => {
    const r = splitClosedCells('Текст [CELL type="html"]<table><tr><td>4');
    expect(r.visible).toBe("Текст ");
    expect(r.cells).toHaveLength(0);
    expect(r.tail.startsWith('[CELL type="html"]')).toBe(true);
  });

  it("hides an incomplete media URL tail", () => {
    const r = splitClosedCells('Кот: [CELL type="image"]https://x/cat');
    expect(r.visible).toBe("Кот: ");
    expect(r.cells).toHaveLength(0);
  });

  it("skips an invalid closed media cell without emitting a placeholder", () => {
    const r = splitClosedCells('a [CELL type="image"]not-a-url[/CELL] b');
    expect(r.visible).toBe("a  b");
    expect(r.cells).toHaveLength(0);
  });

  it("keeps streaming stable across ticks of a growing html table", () => {
    let buf = 'Ответ [CELL type="html"]<table>';
    const first = splitClosedCells(buf);
    expect(first.visible).toBe("Ответ ");
    buf += "<tr><td>1</td></tr></table>[/CELL] готово";
    const second = splitClosedCells(buf);
    expect(second.visible).toBe("Ответ [CELL_0] готово");
    expect(second.cells[0].content).toContain("</table>");
  });
});

describe("stripCellPlaceholders", () => {
  it("removes placeholders and raw blocks", () => {
    expect(stripCellPlaceholders("a [CELL_0] b")).toBe("a  b");
    expect(stripCellPlaceholders('a [CELL type="html"]x[/CELL] b')).toBe("a  b");
    expect(stripCellPlaceholders('a [CELL type="html"]x[/CELL')).toBe("a");
  });
});

// --- security hardening additions (style blocks, CSS exfil, comments) ---

describe("sanitizeCellHtml: CSS and comment hardening", () => {
  it("strips <style> blocks entirely", () => {
    const out = sanitizeCellHtml('<div>ok</div><style>.x{color:red}</style>');
    expect(out).toContain("<div>ok</div>");
    expect(out).not.toContain("color:red");
    expect(out).not.toContain("<style");
  });

  it("drops HTML comments (mXSS channel)", () => {
    const out = sanitizeCellHtml('<p>a</p><!--<img src=x onerror=alert(1)>--><p>b</p>');
    expect(out).not.toContain("<!--");
    expect(out).toContain("<p>a</p>");
    expect(out).toContain("<p>b</p>");
  });

  it("filters url()/import declarations from style attributes", () => {
    const out = sanitizeCellHtml('<td style="color:red;background:url(https://evil.example/x)">t</td>');
    expect(out).toContain("color:red");
    expect(out).not.toContain("url(");
    expect(out).not.toContain("evil.example");
  });

  it("keeps benign inline styles", () => {
    const out = sanitizeCellHtml('<td style="text-align:center;border:1px solid #ccc">t</td>');
    expect(out).toContain("text-align:center");
  });
});
