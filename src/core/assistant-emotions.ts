// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Assistant emotion vocabulary for the avatar overlay.
 * The model tags its mood with <emotion>…</emotion> at the start of the answer
 * (instruction in system-prompt.ts); the tag is stripped from the visible
 * content (strip-reasoning.ts) and the clients render it as a badge + aura on
 * the assistant avatar. Mirrors the <comment> step-commentary channel.
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

/** Emoji badge shown on the avatar; neutral shows none. */
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

/** Values allowed in the <emotion> prompt instruction (comma-joined). */
export const EMOTION_PROMPT_LIST = ASSISTANT_EMOTIONS.filter((e) => e !== "neutral").join(", ");

/** Unknown / missing values fold to neutral so a typo can't break the UI. */
export function normalizeEmotion(raw: string | null | undefined): AssistantEmotion {
  const v = raw?.trim().toLowerCase();
  return (ASSISTANT_EMOTIONS as readonly string[]).includes(v ?? "") ? (v as AssistantEmotion) : "neutral";
}

export function emotionEmoji(raw: string | null | undefined): string {
  return EMOTION_EMOJI[normalizeEmotion(raw)];
}
