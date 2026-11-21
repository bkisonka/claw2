// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { apiBase, apiKey } from "../config";
import { getAuthHeaders } from "../auth/storage";

export type VoiceEmotion = "angry" | "happy" | "neutral" | "sad";

export interface VoiceSttResult {
  text: string;
  /** Gender from voice (if the voice service returned it). */
  gender?: "male" | "female";
  /** Emotion from voice (if the voice service returned it, VOICE_EMOTION_ENABLED). */
  emotion?: VoiceEmotion;
  error?: string;
}

export async function voiceStt(file: Blob | File): Promise<VoiceSttResult> {
  const form = new FormData();
  const isWav = (file.type || "").includes("wav") || (file instanceof File && /\.wav$/i.test(file.name));
  const filename =
    file instanceof File && file.name
      ? file.name
      : isWav
        ? "audio.wav"
        : "audio.webm";
  form.append("file", file, filename);
  const headers: Record<string, string> = { ...getAuthHeaders() };
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
    if (!headers["Authorization"]) headers["Authorization"] = `Bearer ${apiKey}`;
  }
  const res = await fetch(`${apiBase}/api/voice/stt`, {
    method: "POST",
    headers,
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as {
    text?: string;
    gender?: string;
    emotion?: string;
    error?: string | { message?: string; code?: string };
  };
  if (!res.ok) {
    let errMsg = "";
    if (typeof data.error === "string") {
      try {
        const nested = JSON.parse(data.error) as { error?: { message?: string; code?: string }; message?: string };
        errMsg =
          nested.error?.message ||
          nested.message ||
          (nested.error?.code ? String(nested.error.code) : "") ||
          data.error;
      } catch {
        errMsg = data.error;
      }
    } else if (data.error && typeof data.error === "object") {
      errMsg = data.error.message || data.error.code || JSON.stringify(data.error);
    }
    return { text: "", error: errMsg || `HTTP ${res.status}` };
  }
  const gender = data.gender === "male" || data.gender === "female" ? data.gender : undefined;
  const emotion =
    data.emotion === "angry" || data.emotion === "happy" || data.emotion === "neutral" || data.emotion === "sad"
      ? data.emotion
      : undefined;
  return { text: typeof data.text === "string" ? data.text.trim() : "", gender, emotion, error: typeof data.error === "string" ? data.error : undefined };
}

const TTS_MAX_CHARS_DEFAULT = 1000;

export type VoiceTtsEngine = "silero" | "moss" | "xtts";

export interface VoiceCapabilities {
  cudaAvailable: boolean;
  mossAvailable: boolean;
  mossRequiresCuda: boolean;
  requestedEngine: VoiceTtsEngine;
  effectiveEngine: VoiceTtsEngine;
}

export function effectiveTtsEngine(requested: string | undefined, cudaAvailable: boolean): VoiceTtsEngine {
  const v = (requested || "silero").trim().toLowerCase();
  if ((v === "moss" || v === "xtts") && !cudaAvailable) return "silero";
  if (v === "moss" || v === "silero" || v === "xtts") return v;
  return "silero";
}

export async function getVoiceCapabilities(): Promise<VoiceCapabilities> {
  const headers: Record<string, string> = { ...getAuthHeaders() };
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
    if (!headers["Authorization"]) headers["Authorization"] = `Bearer ${apiKey}`;
  }
  try {
    const res = await fetch(`${apiBase}/api/voice/capabilities`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Partial<VoiceCapabilities>;
    const requested = (data.requestedEngine as VoiceTtsEngine) || "silero";
    const cudaAvailable = data.cudaAvailable === true;
    return {
      cudaAvailable,
      mossAvailable: data.mossAvailable === true,
      mossRequiresCuda: data.mossRequiresCuda !== false,
      requestedEngine: requested,
      effectiveEngine: (data.effectiveEngine as VoiceTtsEngine) || effectiveTtsEngine(requested, cudaAvailable),
    };
  } catch {
    return {
      cudaAvailable: false,
      mossAvailable: false,
      mossRequiresCuda: true,
      requestedEngine: "silero",
      effectiveEngine: "silero",
    };
  }
}

export interface TtsVoiceOption {
  id: string;
  name?: string;
}

export interface TtsVoicesResponse {
  voices: TtsVoiceOption[];
  source: "api" | "catalog" | "local";
  current: string;
  error?: string;
}

export async function fetchTtsVoices(): Promise<TtsVoicesResponse> {
  const headers: Record<string, string> = { ...getAuthHeaders() };
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
    if (!headers["Authorization"]) headers["Authorization"] = `Bearer ${apiKey}`;
  }
  const res = await fetch(`${apiBase}/api/voice/tts-voices`, { headers });
  const data = (await res.json().catch(() => ({}))) as TtsVoicesResponse;
  if (!res.ok) {
    return {
      voices: Array.isArray(data.voices) ? data.voices : [],
      source: data.source || "catalog",
      current: typeof data.current === "string" ? data.current : "",
      error: data.error || `HTTP ${res.status}`,
    };
  }
  return {
    voices: Array.isArray(data.voices) ? data.voices : [],
    source: data.source || "catalog",
    current: typeof data.current === "string" ? data.current : "",
    error: data.error,
  };
}

function hasSpeakableContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

export async function voiceTts(
  text: string,
  maxChars: number = TTS_MAX_CHARS_DEFAULT,
  engine?: string,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const trimmed = text.trim();
  if (!trimmed || !hasSpeakableContent(trimmed)) {
    return new ArrayBuffer(0);
  }
  const payload: { text: string; engine?: string } = { text: trimmed.slice(0, maxChars) };
  const eng = engine?.trim();
  if (eng) payload.engine = eng;
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json", ...getAuthHeaders() };
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
    if (!headers["Authorization"]) headers["Authorization"] = `Bearer ${apiKey}`;
  }
  const res = await fetch(`${apiBase}/api/voice/tts`, {
    method: "POST",
    headers,
    body,
    signal,
  });
  if (res.status === 204) return new ArrayBuffer(0);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || `HTTP ${res.status}`);
  }
  return res.arrayBuffer();
}
