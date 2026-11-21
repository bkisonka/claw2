// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Client for voice service (STT + TTS). Used by Telegram bot and, if necessary, by the web.
 */

const STT_TIMEOUT_MS = 60_000;
const TTS_TIMEOUT_MS = 30_000;

export type VoiceEmotion = "angry" | "happy" | "neutral" | "sad";

export interface SttResult {
  text: string;
  /** Gender by voice (if the voice service returned).*/
  gender?: "male" | "female";
  /** Emotion by voice (if the voice service returned, VOICE_EMOTION_ENABLED).*/
  emotion?: VoiceEmotion;
}

/**
 * Recognize speech in the audio buffer. POST multipart file to sttUrl.
 * Returns { text, gender? }. gender is filled in if the voice service supports gender classification.
 */
export async function stt(
  sttUrl: string | undefined,
  audioBuffer: Buffer | Uint8Array,
  filename: string = "voice.ogg",
): Promise<SttResult> {
  if (typeof sttUrl !== "string" || sttUrl.length === 0) {
    throw new Error("sttUrl is required");
  }
  const buf = audioBuffer instanceof Buffer ? audioBuffer : Buffer.from(audioBuffer);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)]), filename);

  const res = await fetch(sttUrl, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(STT_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`STT failed ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as SttResult & { gender?: string; emotion?: string };
  const text = typeof data.text === "string" ? data.text.trim() : "";
  const gender =
    data.gender === "male" || data.gender === "female" ? data.gender : undefined;
  const emotion =
    data.emotion === "angry" || data.emotion === "happy" || data.emotion === "neutral" || data.emotion === "sad"
      ? data.emotion
      : undefined;
  return { text, gender, emotion };
}

/**
 * Synthesize speech from text. POST JSON { text } to ttsUrl, return WAV buffer.
 */
export async function tts(
  ttsUrl: string,
  text: string,
  maxChars?: number,
  engine?: string
): Promise<Buffer> {
  const slice = typeof maxChars === "number" && maxChars > 0
    ? text.slice(0, maxChars).trim()
    : text.trim();
  if (!slice) throw new Error("TTS: empty text");

  const res = await fetch(ttsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: slice,
      ...(engine?.trim() ? { engine: engine.trim().toLowerCase() } : {}),
    }),
    signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`TTS failed ${res.status}: ${errText}`);
  }

  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}
