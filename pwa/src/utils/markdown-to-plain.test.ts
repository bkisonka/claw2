// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it } from "vitest";
import { markdownToPlainText, messagePlainText } from "./markdown-to-plain";

describe("markdownToPlainText", () => {
  it("strips headings, bold and inline code", () => {
    expect(markdownToPlainText("### Заголовок\n**жирный** и `код`")).toBe(
      "Заголовок\nжирный и код"
    );
  });

  it("keeps link text with the url", () => {
    expect(markdownToPlainText("[пример](https://example.com)")).toBe(
      "пример (https://example.com)"
    );
  });

  it("keeps fenced code content without the fences", () => {
    expect(markdownToPlainText("```js\nconst a = 1;\n```")).toBe("const a = 1;");
  });

  it("collapses blank runs", () => {
    expect(markdownToPlainText("a\n\n\n\n\nb")).toBe("a\n\nb");
  });
});

describe("messagePlainText", () => {
  it("drops CELL placeholders entirely", () => {
    expect(messagePlainText("Вот таблица:\n\n[CELL_0]\n\nИ график [CELL_1].")).toBe(
      "Вот таблица:\n\nИ график."
    );
  });

  it("drops raw unclosed [CELL blocks from streamed tails", () => {
    const out = messagePlainText('Текст [CELL type="html"]<table>x</table>');
    expect(out).toBe("Текст");
    expect(out).not.toContain("<table>");
  });

  it("leaves plain user text untouched", () => {
    expect(messagePlainText("Привет, как дела?")).toBe("Привет, как дела?");
  });
});
