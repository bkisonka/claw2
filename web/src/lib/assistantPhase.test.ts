// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it } from "vitest";
import { assistantToolKind, resolveAssistantPhase } from "./assistantPhase";

describe("assistantToolKind", () => {
  it("maps the tool vocabulary onto five legible kinds", () => {
    expect(assistantToolKind("read")).toBe("files");
    expect(assistantToolKind("list_dir")).toBe("files");
    expect(assistantToolKind("edit")).toBe("files");
    expect(assistantToolKind("write")).toBe("files");
    expect(assistantToolKind("web_fetch")).toBe("web");
    expect(assistantToolKind("search")).toBe("web");
    expect(assistantToolKind("open_browser")).toBe("web");
    expect(assistantToolKind("read_browser_page")).toBe("web");
    expect(assistantToolKind("generate_image")).toBe("media");
    expect(assistantToolKind("phone_call")).toBe("media");
    expect(assistantToolKind("remember")).toBe("knowledge");
    expect(assistantToolKind("memory_search")).toBe("knowledge");
    expect(assistantToolKind("chronicle_remember")).toBe("knowledge");
    expect(assistantToolKind("transcript_read")).toBe("knowledge");
    expect(assistantToolKind("tasks_list")).toBe("knowledge");
    expect(assistantToolKind("run_agent")).toBe("agent");
    expect(assistantToolKind("code_skill")).toBe("agent");
  });

  it("falls back to default for an unknown tool", () => {
    expect(assistantToolKind("something_new")).toBe("default");
    expect(assistantToolKind("")).toBe("default");
  });
});

describe("resolveAssistantPhase", () => {
  it("is idle when nothing runs", () => {
    expect(resolveAssistantPhase({ busy: false })).toEqual({ phase: "idle" });
    expect(resolveAssistantPhase({ busy: false, streamingContent: "text", tools: [{ type: "start", name: "read" }] }))
      .toEqual({ phase: "idle" });
  });

  it("is thinking while the turn runs but nothing shows yet", () => {
    expect(resolveAssistantPhase({ busy: true })).toEqual({ phase: "thinking" });
    expect(resolveAssistantPhase({ busy: true, streamingContent: "" })).toEqual({ phase: "thinking" });
  });

  it("is tool while a started step has not ended, with the kind of that tool", () => {
    expect(
      resolveAssistantPhase({
        busy: true,
        streamingContent: "partial text",
        tools: [
          { type: "start", name: "read" },
          { type: "end", name: "read" },
          { type: "start", name: "web_fetch" },
        ],
      })
    ).toEqual({ phase: "tool", toolKind: "web" });
    expect(
      resolveAssistantPhase({ busy: true, tools: [{ type: "start", name: "list_dir" }] })
    ).toEqual({ phase: "tool", toolKind: "files" });
  });

  it("is answer once visible text streams and no tool runs", () => {
    expect(
      resolveAssistantPhase({
        busy: true,
        streamingContent: "Отлично,",
        tools: [{ type: "end", name: "read" }],
      })
    ).toEqual({ phase: "answer" });
    expect(resolveAssistantPhase({ busy: true, streamingContent: "   " })).toEqual({ phase: "thinking" });
  });
});
