// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * The assistant emotion vocabulary, mirrored from src/core/assistant-emotions.ts
 * (the web client shares no code with the gateway). The model tags its mood
 * with <emotion>…</emotion>; the gateway strips the tag and delivers the value,
 * the UI shows it as a badge + aura on the avatar.
 */

export const ASSISTANT_EMOTIONS = [
  "neutral",
  "happy",
  "excited",
  "curious",
  "thinking",
  "surprised",
  "concerned",
  "sad",
  "playful",
  "proud",
  "grateful",
] as const;

export type AssistantEmotion = (typeof ASSISTANT_EMOTIONS)[number];

export const EMOTION_EMOJI: Record<AssistantEmotion, string> = {
  neutral: "",
  happy: "😊",
  excited: "🤩",
  curious: "🧐",
  thinking: "🤔",
  surprised: "😲",
  concerned: "😟",
  sad: "😢",
  playful: "😜",
  proud: "😎",
  grateful: "🙏",
};

/** Unknown / missing values fold to neutral so a typo can't break the UI. */
export function normalizeEmotion(raw: string | null | undefined): AssistantEmotion {
  const v = raw?.trim().toLowerCase();
  return (ASSISTANT_EMOTIONS as readonly string[]).includes(v ?? "") ? (v as AssistantEmotion) : "neutral";
}

export function emotionEmoji(raw: string | null | undefined): string {
  return EMOTION_EMOJI[normalizeEmotion(raw)];
}
