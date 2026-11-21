// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it } from "vitest";
import { composeWebchatUserPayload } from "./content-boundary.js";

describe("composeWebchatUserPayload", () => {
  it("wraps plain webchat messages", () => {
    const out = composeWebchatUserPayload("hello");
    expect(out).toContain("<<<EXT>>>");
    expect(out).toContain("Source: webchat");
    expect(out).toContain("hello");
    expect(out).toContain("<<</EXT>>>");
  });

  it("keeps user text outside browser EXT block", () => {
    const out = composeWebchatUserPayload("Explain this", {
      text: "secret snippet",
      url: "https://example.com/page",
      title: "Example",
    });
    expect(out.startsWith("Explain this")).toBe(true);
    expect(out).toContain("Source: browser");
    expect(out).toContain("Sender: https://example.com/page");
    expect(out).toContain("Subject: Example");
    expect(out).toContain("secret snippet");
    expect(out).not.toContain("Source: webchat");
  });

  it("attaches current page location without selection", () => {
    const out = composeWebchatUserPayload("What is this article about?", {
      url: "https://habr.com/ru/articles/1/",
      title: "Currency names",
    });
    expect(out.startsWith("What is this article about?")).toBe(true);
    expect(out).toContain("Source: browser");
    expect(out).toContain("Sender: https://habr.com/ru/articles/1/");
    expect(out).toContain("Subject: Currency names");
    expect(out).toContain("No text selection");
    expect(out).not.toContain("Source: webchat");
  });

  it("uses rendered snippet when there is no selection", () => {
    const out = composeWebchatUserPayload("Summarize", {
      snippet: "First paragraph of the article…",
      url: "https://example.com/a",
      title: "A",
    });
    expect(out).toContain("First paragraph of the article…");
    expect(out).not.toContain("No text selection");
    expect(out).toContain("Source: browser");
  });
});
