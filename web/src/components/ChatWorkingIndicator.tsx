// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useEffect, useState } from "react";
import { useT } from "../i18n";
import type { MessageKey } from "../i18n";

const PENDING_KEYS: MessageKey[] = [
  "chat.workingThinking",
  "chat.workingPreparing",
  "chat.workingStill",
];

const ROTATE_MS = 2600;

type Props = {
  /** Show rotating “thinking” labels (before first tokens). */
  showLabel?: boolean;
  /** Blinking caret — while the reply is still streaming. */
  showCursor?: boolean;
  className?: string;
};

/**
 * Live work cue while the model runs: verbal status + caret (W overlay + C feed).
 */
export function ChatWorkingIndicator({
  showLabel = true,
  showCursor = true,
  className,
}: Props) {
  const t = useT();
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    if (!showLabel) return;
    setPhase(0);
    const id = window.setInterval(() => {
      setPhase((p) => (p + 1) % PENDING_KEYS.length);
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, [showLabel]);

  if (!showLabel && !showCursor) return null;

  return (
    <span className={`chat-working-indicator${className ? ` ${className}` : ""}`} role="status" aria-live="polite">
      {showLabel ? (
        <span className="chat-working-label">{t(PENDING_KEYS[phase] ?? PENDING_KEYS[0]!)}</span>
      ) : null}
      {showCursor ? (
        <span className="chat-working-cursor" aria-hidden>
          ▍
        </span>
      ) : null}
    </span>
  );
}
