// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * What the assistant is doing right now, derived from what the feed already
 * shows — no engine changes. The avatar animation reads this state: a slow
 * contour crawl is "thinking", short pulses are "working with a tool" (the
 * hue is the tool kind), an even breathing is "writing the answer".
 */

export type AssistantPhase = "idle" | "thinking" | "tool" | "answer";
export type AssistantToolKind = "files" | "web" | "media" | "knowledge" | "agent" | "default";

/** The offline engine's own tool vocabulary. */
const TOOL_KIND_BY_EXACT: Record<string, AssistantToolKind> = {
  read_file: "files",
  list_files: "files",
  save_document: "files",
  web_search: "web",
  fetch_url: "web",
  generate_image: "media",
  remember: "knowledge",
  recall: "knowledge",
  set_reminder: "knowledge",
  cancel_reminder: "knowledge",
};

export function assistantToolKind(name: string): AssistantToolKind {
  return TOOL_KIND_BY_EXACT[name.trim()] ?? "default";
}

export function resolveAssistantPhase(input: {
  busy: boolean;
  streamingContent?: string;
  toolActive?: string;
}): { phase: AssistantPhase; toolKind?: AssistantToolKind } {
  if (input.busy && input.toolActive?.trim()) {
    return { phase: "tool", toolKind: assistantToolKind(input.toolActive) };
  }
  if (input.busy && (input.streamingContent ?? "").trim()) return { phase: "answer" };
  if (input.busy) return { phase: "thinking" };
  return { phase: "idle" };
}
