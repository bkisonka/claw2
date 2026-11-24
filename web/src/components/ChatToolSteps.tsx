// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useEffect, useState } from "react";
import type { ToolStep } from "../api/chat";
import { useT } from "../i18n";
import { formatStepDuration, isStepRunning, toolStepSubject, toolStepTitle, totalStepDuration } from "../lib/toolSteps";

type Props = {
  steps: ToolStep[];
  /** The turn is still running: the list stays open and its summary names the current step. */
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
 * The tool steps of an assistant turn. While the turn runs the steps are
 * listed as they happen — what the agent is doing instead of a bare
 * "thinking" label; once it is over they fold into one line.
 */
export function ChatToolSteps({ steps, running }: Props) {
  const t = useT();
  const [open, setOpen] = useState(running);
  // Open while the turn runs, folded once it is over (the user can toggle either way).
  useEffect(() => {
    setOpen(running);
  }, [running]);
  if (!steps.length) return null;

  const current = steps.find(isStepRunning);
  const total = totalStepDuration(steps);
  const count = t("chat.stepsCount", { count: steps.length });
  const totalLabel = formatStepDuration(total);
  const summary = running
    ? current
      ? t("chat.stepsRunning", { name: toolStepTitle(current) })
      : count
    : totalLabel
      ? `${count} · ${totalLabel}`
      : count;

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
