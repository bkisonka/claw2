import { describe, expect, it } from "vitest";
import { normalizePageKey, pageKeyLabel } from "./pageKey";

describe("normalizePageKey", () => {
  it("returns null for blank", () => {
    expect(normalizePageKey("")).toBeNull();
    expect(normalizePageKey("about:blank")).toBeNull();
  });

  it("strips hash, www, and tracking params", () => {
    expect(
      normalizePageKey("https://www.Example.com/a/b?id=1&utm_source=x&fbclid=y#frag")
    ).toBe("https://example.com/a/b?id=1");
  });

  it("keeps meaningful query", () => {
    expect(normalizePageKey("https://example.com/item?id=42")).toBe(
      "https://example.com/item?id=42"
    );
  });

  it("rejects non-http", () => {
    expect(normalizePageKey("file:///tmp/x")).toBeNull();
  });
});

describe("pageKeyLabel", () => {
  it("prefers title", () => {
    expect(pageKeyLabel("https://example.com/a", "Hello")).toBe("Hello");
  });

  it("falls back to host+path", () => {
    expect(pageKeyLabel("https://example.com/a/b")).toBe("example.com/a/b");
  });
});
