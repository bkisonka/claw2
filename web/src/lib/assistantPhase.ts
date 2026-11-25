// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * What the assistant is doing right now, derived from what the client already
 * sees — no new gateway events. The avatar animation reads this state, so the
 * pattern itself carries the information: a slow contour crawl is "thinking",
 * short pulses are "working with a tool", an even breathing is "writing the
 * answer". The tool category only tints the pulse.
 */

/** The last step whose latest event is `start` is still running; history steps have no type (always finished). */
export interface PhaseToolStep {
  type?: "start" | "end";
  name: string;
}

export type AssistantPhase = "idle" | "thinking" | "tool" | "answer";
export type AssistantToolKind = "files" | "web" | "media" | "knowledge" | "agent" | "default";

const TOOL_KIND_BY_EXACT: Record<string, AssistantToolKind> = {
  read: "files",
  write: "files",
  edit: "files",
  list_dir: "files",
  web_fetch: "web",
  search: "web",
  open_browser: "web",
  read_browser_page: "web",
  generate_image: "media",
  phone_call: "media",
  remember: "knowledge",
  read_secret: "knowledge",
};

const TOOL_KIND_BY_PREFIX: [string, AssistantToolKind][] = [
  ["memory_", "knowledge"],
  ["chronicle_", "knowledge"],
  ["transcript_", "knowledge"],
  ["tasks_", "knowledge"],
  ["reminder_", "knowledge"],
  ["sidebar_", "knowledge"],
  ["room_", "knowledge"],
  ["run_agent", "agent"],
  ["write_agent", "agent"],
  ["code_skill", "agent"],
  ["accept_skill", "agent"],
];

export function assistantToolKind(name: string): AssistantToolKind {
  const exact = TOOL_KIND_BY_EXACT[name.trim()];
  if (exact) return exact;
  const lower = name.trim().toLowerCase();
  for (const [prefix, kind] of TOOL_KIND_BY_PREFIX) {
    if (lower.startsWith(prefix)) return kind;
  }
  return "default";
}

export interface AssistantPhaseInput {
  /** A turn of this chat is in progress (streaming or waiting). */
  busy: boolean;
  /** The message being streamed, when there is one on screen. */
  streamingContent?: string;
  /** Tool steps of that message (start/end events as they arrived). */
  tools?: PhaseToolStep[];
}

export function resolveAssistantPhase(input: AssistantPhaseInput): {
  phase: AssistantPhase;
  toolKind?: AssistantToolKind;
} {
  // The latest event decides: a start without its end yet is a running tool.
  const lastEvent = input.tools?.[input.tools.length - 1];
  if (input.busy && lastEvent?.type === "start") {
    return { phase: "tool", toolKind: assistantToolKind(lastEvent.name) };
  }
  if (input.busy && (input.streamingContent ?? "").trim()) return { phase: "answer" };
  if (input.busy) return { phase: "thinking" };
  return { phase: "idle" };
}
