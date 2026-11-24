// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useState } from "react";
import type { ToolStep } from "../api/chat";
import { useT } from "../i18n";
import { formatStepDuration, isStepRunning, stepsTicker, tickerDuration, toolStepSubject, totalStepDuration } from "../lib/toolSteps";

type Props = {
  steps: ToolStep[];
  /** The turn is still running: the header carries the steps as a ticker line. */
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
 * runs, the header carries the steps as a ticker line, and the fold is there
 * to read the whole list when wanted.
 */
export function ChatToolSteps({ steps, running }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // Fixed for the lifetime of the line: re-timing the marquee on every step
  // would make it jump.
  const [duration] = useState(() => tickerDuration(stepsTicker(steps)));
  if (!steps.length) return null;

  const total = totalStepDuration(steps);
  const count = t("chat.stepsCount", { count: steps.length });
  const totalLabel = formatStepDuration(total);
  const summary = totalLabel ? `${count} · ${totalLabel}` : count;
  const ticker = running ? stepsTicker(steps) : "";

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
        {ticker ? (
          <span className="chat-tool-steps-ticker" aria-hidden>
            <span className="chat-tool-steps-ticker-line" style={{ animationDuration: duration }}>
              {ticker}
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
