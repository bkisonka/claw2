// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { getSettings, onSettingsChange } from "../engine/settings";
import { EMOTION_EMOJI, normalizeEmotion } from "../engine/emotions";
import { useEffect, useState } from "react";
import type { AssistantPhase, AssistantToolKind } from "../lib/assistantPhase";

/**
 * The assistant's face on the phone: a circle with its avatar (preset emoji
 * or an uploaded image kept in local settings). The animation pattern is
 * bound to the work phase, the emotion rides on top as a badge + aura.
 * Fully offline: the avatar lives in engine settings, not on any gateway.
 */

export type AssistantAvatarSize = "msg" | "bar" | "welcome";

export function useAssistantAvatar(): string {
  const [avatar, setAvatar] = useState(() => getSettings().assistantAvatar || "🤖");
  useEffect(() => onSettingsChange((s) => setAvatar(s.assistantAvatar || "🤖")), []);
  return avatar;
}

/** The user-set avatar diameter; every surface scales from this CSS variable. */
export function useAssistantAvatarSize(): number {
  const [size, setSize] = useState(() => getSettings().assistantAvatarSize || 52);
  useEffect(() => {
    document.documentElement.style.setProperty("--avatar-size", `${size}px`);
    return onSettingsChange((s) => {
      const next = s.assistantAvatarSize || 52;
      setSize(next);
      document.documentElement.style.setProperty("--avatar-size", `${next}px`);
    });
  }, [size]);
  return size;
}

export function useAssistantName(): string {
  const [name, setName] = useState(() => getSettings().assistantName || "Claw2");
  useEffect(() => onSettingsChange((s) => setName(s.assistantName || "Claw2")), []);
  return name;
}

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
  const avatar = useAssistantAvatar();
  useAssistantAvatarSize();
  const isImage = avatar.startsWith("data:");
  const emotionKey = emotion ? normalizeEmotion(emotion) : null;
  const badge = emotionKey ? EMOTION_EMOJI[emotionKey] : "";
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
        {isImage ? <img className="assistant-avatar-img" src={avatar} alt="" /> : avatar}
      </span>
      {badge ? <span className="assistant-avatar-badge">{badge}</span> : null}
    </span>
  );
}
