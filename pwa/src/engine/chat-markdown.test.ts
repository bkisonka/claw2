// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it } from "vitest";
import {
  buildChatMarkdown,
  markdownFileName,
  renderCellForExport,
} from "./chat-markdown";

describe("buildChatMarkdown", () => {
  it("follows the desktop layout: title, export line, role sections", () => {
    const md = buildChatMarkdown({
      title: "Тестовый чат",
      date: new Date(2026, 9, 17, 12, 30),
      messages: [
        { role: "user", content: "Привет" },
        { role: "assistant", content: "Привет! Чем помочь?" },
      ],
    });
    expect(md).toContain("# Тестовый чат");
    expect(md).toContain("Экспорт: 17.10.2026");
    expect(md).toContain("## Вы\n\nПривет");
    expect(md).toContain("## Агент\n\nПривет! Чем помочь?");
  });

  it("replaces [CELL_N] placeholders with fenced blocks", () => {
    const md = buildChatMarkdown({
      title: "t",
      messages: [
        {
          role: "assistant",
          content: "Вот таблица:\n\n[CELL_0]\n\nИ график [CELL_1] готов.",
          cells: [
            { type: "html", content: "<table><tr><td>1</td></tr></table>" },
            { type: "chart", content: '{"series":[1,2]}' },
          ],
        },
      ],
    });
    expect(md).toContain("```html\n<table><tr><td>1</td></tr></table>\n```");
    expect(md).toContain('```json\n{"series":[1,2]}\n```');
    expect(md).not.toContain("[CELL_0]");
    expect(md).toContain("И график");
  });

  it("renders media cells as notes, never base64", () => {
    const md = buildChatMarkdown({
      title: "t",
      messages: [
        {
          role: "assistant",
          content: "[CELL_0]",
          cells: [{ type: "image", content: "data:image/png;base64,AAAA" }],
        },
      ],
    });
    expect(md).toContain("изображение — сохранено в приложении");
    expect(md).not.toContain("base64");
  });

  it("notes attached files and skips deleted ones", () => {
    const md = buildChatMarkdown({
      title: "t",
      messages: [
        {
          role: "user",
          content: "Смотри",
          attachedFiles: [
            { name: "отчёт.pdf" },
            { name: "старое.png", deleted: true },
          ],
        },
      ],
    });
    expect(md).toContain("> 📎 отчёт.pdf");
    expect(md).not.toContain("старое.png");
  });

  it("keeps an empty message visible", () => {
    const md = buildChatMarkdown({ title: "t", messages: [{ role: "user", content: "" }] });
    expect(md).toContain("*(пусто)*");
  });
});

describe("renderCellForExport", () => {
  it("fences unknown cell types without a language", () => {
    expect(renderCellForExport({ type: "mystic", content: "  x  " })).toBe("```\nx\n```");
  });
});

describe("markdownFileName", () => {
  it("sanitizes like the desktop and caps at 50 chars", () => {
    expect(markdownFileName("Мой чат: план/факт?")).toBe("Мой чат_ план_факт_.md");
    expect(markdownFileName("x".repeat(80)).length).toBe(53); // 50 + ".md"
    expect(markdownFileName("   ")).toBe("chat.md");
  });
});
