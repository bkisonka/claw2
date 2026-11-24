// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/** Tool steps of an assistant turn: how the step list is built and labelled. */
import type { ToolStep } from "../api/chat";
import { t } from "../i18n";

/**
 * Adds a live step, or completes the one it belongs to: a step arrives as a
 * "start" event and later as an "end" event with the same seq.
 */
export function upsertToolStep(steps: readonly ToolStep[], step: ToolStep): ToolStep[] {
  const index = step.seq == null ? -1 : steps.findIndex((s) => s.seq === step.seq);
  if (index < 0) return [...steps, step];
  const next = [...steps];
  next[index] = { ...next[index]!, ...step };
  return next;
}

/** A live step is running from its "start" event until its "end" event. */
export function isStepRunning(step: ToolStep): boolean {
  return step.type === "start";
}

/** Argument keys that say best what a call is about, most telling first. */
const SUBJECT_KEYS = ["script", "path", "query", "url", "id", "name", "action", "webhookUrl", "to", "taskId"];
const SUBJECT_MAX_CHARS = 72;
const SUBJECT_FALLBACK_MAX_CHARS = 120;

function clipSubject(text: string): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > SUBJECT_MAX_CHARS ? `${flat.slice(0, SUBJECT_MAX_CHARS - 1)}…` : flat;
}

/**
 * The main argument of a step for display — the path, the query, the script.
 * "" when the arguments say nothing short enough to show.
 */
export function toolStepSubject(step: ToolStep): string {
  const raw = (step.args ?? "").trim();
  if (!raw) return "";
  let args: unknown;
  try {
    args = JSON.parse(raw);
  } catch {
    return clipSubject(raw);
  }
  if (typeof args === "string") return clipSubject(args);
  if (!args || typeof args !== "object") return clipSubject(raw);
  const record = args as Record<string, unknown>;
  for (const key of SUBJECT_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return clipSubject(value);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  // No known key: the first short string value says more than the raw JSON.
  for (const value of Object.values(record)) {
    if (typeof value === "string" && value.trim() && value.length <= SUBJECT_FALLBACK_MAX_CHARS) return clipSubject(value);
  }
  return "";
}

/** Tool name plus its main argument: "web_fetch https://example.test/page". */
export function toolStepTitle(step: ToolStep): string {
  const subject = toolStepSubject(step);
  return subject ? `${step.name} ${subject}` : step.name;
}

/** The status mark of a step: running, done, failed, or cut short. */
export function stepMark(step: ToolStep): string {
  if (isStepRunning(step)) return "…";
  if (step.ok == null) return "–";
  return step.ok ? "✓" : "✕";
}

/** One step as a single header line: "run_agent download-file.js ✓924 ms". */
export function stepLine(step: ToolStep): string {
  const mark = stepMark(step);
  const duration = formatStepDuration(step.durationMs);
  // A finished step carries its duration — succeeded or failed; a running
  // or cut-short one has none to show.
  const note = mark === "…" || mark === "–" || duration == null ? mark : `${mark}${duration}`;
  return [toolStepTitle(step), note].filter(Boolean).join(" ");
}

/** "12 ms" / "2.3 s"; null when the step has no duration (still running or interrupted). */
export function formatStepDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return t("chat.stepsMs", { n: Math.round(ms) });
  return t("chat.stepsSec", { n: (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) });
}

/** Sum of the finished steps' durations in ms. */
export function totalStepDuration(steps: readonly ToolStep[]): number {
  return steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0);
}
