import { describe, expect, it } from "vitest";
import {
  anchorsToMarkdown,
  extractContentHtml,
  htmlToText,
  isContentHref,
  looksLikeHtml,
  truncateText,
} from "./html-to-text.js";

describe("html-to-text", () => {
  it("looksLikeHtml detects content-type and markup", () => {
    expect(looksLikeHtml("hello", "text/html; charset=utf-8")).toBe(true);
    expect(looksLikeHtml("<!DOCTYPE html><html><body>x</body></html>")).toBe(true);
    expect(looksLikeHtml('{"a":1}', "application/json")).toBe(false);
    expect(looksLikeHtml("plain text")).toBe(false);
  });

  it("strips scripts/styles and returns readable text", () => {
    const html = `<!DOCTYPE html>
<html><head><style>.x{color:red}</style><script>alert(1)</script></head>
<body>
  <nav>Menu</nav>
  <article><h1>Title</h1><p>Hello&nbsp;<b>world</b>.</p></article>
</body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("Title");
    expect(text).toContain("Hello world.");
    expect(text).not.toContain("<script");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
  });

  it("keeps content links as markdown and drops nav links", () => {
    const html = `<html><body>
<nav><a href="/home">Home</a><a href="/login">Login</a></nav>
<article>
  <p>See <a href="https://example.com/doc">the docs</a> and
  <a href="#section">jump</a>.</p>
  <a href="javascript:void(0)">click</a>
</article>
<footer><a href="/about">About</a></footer>
</body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("[the docs](https://example.com/doc)");
    expect(text).toContain("jump");
    expect(text).not.toContain("](#section)");
    expect(text).not.toContain("javascript:");
    expect(text).not.toContain("[Home]");
    expect(text).not.toContain("[Login]");
    expect(text).not.toContain("[About]");
  });

  it("extractContentHtml prefers article", () => {
    const html = `<body><nav>n</nav><article>BODY</article></body>`;
    expect(extractContentHtml(html)).toContain("BODY");
    expect(extractContentHtml(html)).not.toContain("<nav>");
  });

  it("isContentHref filters chrome schemes", () => {
    expect(isContentHref("https://a.com/x", "x")).toBe(true);
    expect(isContentHref("/path", "x")).toBe(true);
    expect(isContentHref("#frag", "x")).toBe(false);
    expect(isContentHref("javascript:void(0)", "x")).toBe(false);
    expect(isContentHref("https://a.com", "")).toBe(false);
  });

  it("anchorsToMarkdown escapes labels", () => {
    const out = anchorsToMarkdown(`<a href="https://e.com">[x]</a>`);
    expect(out).toBe(`[\\[x\\]](https://e.com)`);
  });

  it("truncates with marker", () => {
    const long = "a".repeat(100);
    const out = htmlToText(`<p>${long}</p>`, 40);
    expect(out.length).toBeLessThan(100);
    expect(out).toContain("[truncated, total");
  });

  it("truncateText leaves short strings alone", () => {
    expect(truncateText("hi", 10)).toBe("hi");
  });
});
