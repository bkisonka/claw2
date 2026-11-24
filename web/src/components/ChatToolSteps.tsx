// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useState } from "react";
import type { ToolStep } from "../api/chat";
import { useT } from "../i18n";
import { formatStepDuration, isStepRunning, stepLine, toolStepSubject, totalStepDuration } from "../lib/toolSteps";

type Props = {
  steps: ToolStep[];
  /** The turn is still running: the header shows the steps one line at a time, as they arrive. */
  running: boolean;
};

type StepStatus = "running" | "ok" | "error" | "interrupted";

function stepStatus(step: ToolStep): StepStatus {
  if (isStepRunning(step)) return "running";
  if (step.ok == null) return "interrupted";
  return step.ok ? "ok" : "error";
}

const STATUS_MARK: Record<StepStatus, string> = {
  running: "…",
  ok: "✓",
  error: "✕",
  interrupted: "–",
};

/**
 * The tool steps of an assistant turn. The fold stays closed: while the turn
 * runs, the header shows one step per line, advancing as the steps arrive —
 * each new one slides up from below, the previous one out above — and the
 * fold is there to read the whole list when wanted.
 */
export function ChatToolSteps({ steps, running }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [reducedMotion] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false);
  // The line the header shows. It advances as the steps arrive, never on a
  // timer: between steps the line stands still.
  const [shown, setShown] = useState(() => {
    const latest = steps[steps.length - 1];
    return { seq: latest?.seq ?? null, text: latest ? stepLine(latest) : "", leaving: "", tick: 0 };
  });
  if (!steps.length) return null;

  const latest = steps[steps.length - 1]!;
  const latestText = stepLine(latest);
  const latestSeq = latest.seq ?? null;
  if (running && (latestSeq !== shown.seq || latestText !== shown.text)) {
    // A different seq is a new step: the old line slides up and out. The end
    // event of the current one only swaps the text in place.
    const isNewStep = latestSeq !== shown.seq;
    setShown({
      seq: latestSeq,
      text: latestText,
      leaving: isNewStep && !reducedMotion && shown.text ? shown.text : "",
      tick: isNewStep ? shown.tick + 1 : shown.tick,
    });
  }

  const total = totalStepDuration(steps);
  const count = t("chat.stepsCount", { count: steps.length });
  const totalLabel = formatStepDuration(total);
  const summary = totalLabel ? `${count} · ${totalLabel}` : count;

  return (
    <div className="chat-tool-steps" data-running={running ? "true" : undefined}>
      <button
        type="button"
        className="chat-tool-steps-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title={t("chat.stepsToggleTitle")}
      >
        <span className="chat-tool-steps-chevron" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <span className="chat-tool-steps-summary">{summary}</span>
        {running ? (
          <span className="chat-steps-cycler" aria-hidden>
            {shown.leaving ? (
              <span
                key={`out-${shown.tick}`}
                className="chat-steps-cycler-line chat-steps-cycler-line--out"
                onAnimationEnd={() => setShown((prev) => (prev.tick === shown.tick ? { ...prev, leaving: "" } : prev))}
              >
                {shown.leaving}
              </span>
            ) : null}
            <span
              key={`in-${shown.tick}`}
              className={`chat-steps-cycler-line${shown.leaving ? " chat-steps-cycler-line--in" : ""}`}
            >
              {shown.text}
            </span>
          </span>
        ) : null}
      </button>
      {open ? (
        <ol className="chat-tool-steps-list">
          {steps.map((step, index) => {
            const status = stepStatus(step);
            const subject = toolStepSubject(step);
            const note =
              status === "interrupted"
                ? t("chat.stepsInterrupted")
                : status === "error"
                  ? [t("chat.stepsFailed"), formatStepDuration(step.durationMs)].filter(Boolean).join(" · ")
                  : (formatStepDuration(step.durationMs) ?? "");
            return (
              <li key={step.seq ?? index} className="chat-tool-step" data-status={status}>
                <span className="chat-tool-step-mark" aria-hidden>
                  {STATUS_MARK[status]}
                </span>
                <span className="chat-tool-step-name">{step.name}</span>
                {subject ? <span className="chat-tool-step-subject">{subject}</span> : null}
                {note ? <span className="chat-tool-step-note">{note}</span> : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
