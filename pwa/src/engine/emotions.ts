// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Assistant emotion vocabulary for the avatar overlay — the PWA is fully
 * offline and shares no code with the gateway, so the <emotion> tag channel is
 * mirrored here: the model opens the answer with the tag, the engine strips it
 * from the visible text and hands the value to the UI.
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

/** Pull the first <emotion>…</emotion> (and a trailing unterminated one) out of the text. */
export function extractEmotionTag(text: string | null | undefined): {
  content: string;
  emotion?: string;
} {
  if (!text) return { content: text ?? "" };
  let emotion: string | undefined;
  const stripped = text.replace(/\s*<emotion>([^<]*)<\/emotion\s*>/gi, (_block, inner: string) => {
    const value = inner.trim();
    if (value && emotion === undefined) emotion = value;
    return "";
  });
  let content = stripped;
  const open = content.search(/<emotion>/i);
  if (open >= 0) {
    const tail = content.slice(open + "<emotion>".length).trim();
    if (tail && emotion === undefined) emotion = tail;
    content = content.slice(0, open).replace(/\s+$/, "");
  }
  // The tag stands at the head of the answer: what follows it is the reply.
  return { content: content.replace(/^\s+/, ""), emotion };
}

/** Strip every emotion tag (closed or unterminated) from the text. */
export function stripEmotionTags(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/\s*<emotion>[^<]*<\/emotion\s*>/gi, "")
    .replace(/\s*<emotion>[^<]*$/i, "")
    .trim();
}
