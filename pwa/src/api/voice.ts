// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * PTT voice: STT via an OpenAI-compatible endpoint —
 * POST {sttBaseURL}/audio/transcriptions, multipart file+model, API key as
 * Bearer. A base URL that already ends in a known transcription path
 * (/audio/transcriptions or a legacy local-service /stt) is used as-is.
 */
import { getSettings } from "../engine/settings";

export interface VoiceSttResult {
  text: string;
  error?: string;
  /** HTTP status when the server answered and rejected the request — the
   *  caller retries such failures with a PCM WAV re-encode. */
  status?: number;
}

/** {base}/audio/transcriptions, unless base is already a transcription path. */
export function sttEndpoint(baseURL: string): string {
  const base = baseURL.trim().replace(/\/+$/, "");
  if (/\/(audio\/transcriptions|stt)$/i.test(base)) return base;
  return `${base}/audio/transcriptions`;
}

/** Accepts OpenAI JSON ({text} / {error}) and plain-text responses. */
export function parseSttResponse(raw: string, status: number): VoiceSttResult {
  try {
    const data = JSON.parse(raw) as {
      text?: string;
      error?: string | { message?: string; code?: string };
    };
    let errMsg = "";
    if (typeof data.error === "string") errMsg = data.error;
    else if (data.error && typeof data.error === "object") {
      errMsg = data.error.message || data.error.code || JSON.stringify(data.error);
    }
    if (status >= 400) return { text: "", error: errMsg || `HTTP ${status}`, status };
    if (errMsg) return { text: "", error: errMsg };
    return { text: typeof data.text === "string" ? data.text.trim() : "" };
  } catch {
    if (status >= 400) return { text: "", error: `HTTP ${status}`, status };
    // response_format=text or a bare-text local service
    return { text: raw.trim() };
  }
}

const STT_TIMEOUT_MS = 60_000;

export async function voiceStt(file: Blob | File): Promise<VoiceSttResult> {
  const { voice } = getSettings();
  const base = voice.sttBaseURL.trim();
  if (!base) {
    return { text: "", error: "STT не настроен — Настройки → Голос (Base URL, модель)" };
  }
  const form = new FormData();
  // Name by the real container: audio/mp4 named ".webm" made strict servers
  // reject the upload. OpenAI-compatible endpoints take webm/mp4 natively.
  const type = (file.type || "").toLowerCase();
  const isWav = type.includes("wav") || (file instanceof File && /\.wav$/i.test(file.name));
  const ext = isWav ? "wav" : /mp4|m4a/.test(type) ? "mp4" : /ogg|opus/.test(type) ? "ogg" : "webm";
  const filename = file instanceof File && file.name ? file.name : `audio.${ext}`;
  form.append("file", file, filename);
  const model = voice.sttModel.trim();
  if (model) form.append("model", model);
  const headers: Record<string, string> = {};
  if (voice.sttApiKey) headers.Authorization = `Bearer ${voice.sttApiKey}`;
  let res: Response;
  try {
    // Bounded: a hung STT endpoint must not hold the radio and the mic UI
    // ("Распознаю…") forever.
    res = await fetch(sttEndpoint(base), {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(STT_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      return { text: "", error: `STT не ответил за ${STT_TIMEOUT_MS / 1000} с` };
    }
    return { text: "", error: e instanceof Error ? e.message : "Сеть недоступна" };
  }
  return parseSttResponse(await res.text(), res.status);
}
