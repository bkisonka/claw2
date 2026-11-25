// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useAssistantIdentity } from "../context/AssistantIdentityContext";
import { emotionEmoji, normalizeEmotion } from "../lib/assistantEmotions";
import type { AssistantPhase, AssistantToolKind } from "../lib/assistantPhase";

/**
 * The assistant's face: a circle with its avatar (preset emoji or uploaded
 * image). The animation pattern is bound to the work phase, not to a timer —
 * thinking crawls along the contour, a tool pings in short pulses, the answer
 * breathes evenly; the emotion rides on top as a badge + aura. Idle is a
 * plain static circle.
 */

export type AssistantAvatarSize = "msg" | "bar" | "welcome";

export function AssistantAvatar({
  size = "msg",
  phase = "idle",
  toolKind,
  emotion,
}: {
  size?: AssistantAvatarSize;
  phase?: AssistantPhase;
  toolKind?: AssistantToolKind;
  emotion?: string | null;
}) {
  const { identity } = useAssistantIdentity();
  const avatar = identity?.avatar ?? { kind: "preset" as const, value: "🤖" };
  const badge = emotion ? emotionEmoji(emotion) : "";
  const emotionKey = emotion ? normalizeEmotion(emotion) : null;
  const classes = [
    "assistant-avatar",
    `assistant-avatar--${size}`,
    `assistant-avatar--${phase}`,
    phase === "tool" && toolKind ? `assistant-avatar-kind--${toolKind}` : "",
    emotionKey && emotionKey !== "neutral" ? `assistant-avatar-aura--${emotionKey}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes} aria-hidden>
      <span className="assistant-avatar-disc">
        {avatar.kind === "image" ? (
          <img className="assistant-avatar-img" src={avatar.dataUrl} alt="" />
        ) : (
          avatar.value
        )}
      </span>
      {badge ? <span className="assistant-avatar-badge">{badge}</span> : null}
    </span>
  );
}

/** The assistant's display name, falling back to the plain "Agent" label. */
export function useAssistantDisplayName(fallback: string): string {
  const { identity } = useAssistantIdentity();
  return identity?.name?.trim() || fallback;
}
