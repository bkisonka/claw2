// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * TTS/STT bridge for SIP calls using claw2 voice.* config.
 */
import type { Claw2Config } from "../config/types.js";
import {
  resolveSttApiKey,
  resolveSttLocal,
  resolveSttModel,
  resolveTtsApiKey,
  resolveTtsEngine,
  resolveTtsLocal,
  resolveTtsModel,
  resolveTtsVoice,
  resolveVoiceSttUrl,
  resolveVoiceTtsUrl,
  openaiAudioBase,
} from "../config/voice.js";
import { stt as localStt, tts as localTts } from "../channels/voice-client.js";
import { buildWavPcm, SIP_PCM_RATE, wavToSipPcm } from "./audio.js";

const TTS_TIMEOUT_MS = 60_000;
const STT_TIMEOUT_MS = 60_000;

export async function synthesizeSipPcm(config: Claw2Config, text: string): Promise<Buffer> {
  const slice = text.trim();
  if (!slice) throw new Error("TTS: empty text");

  const ttsUrl = resolveVoiceTtsUrl(config);
  if (!ttsUrl) throw new Error("Voice TTS not configured (voice.ttsUrl)");

  let wav: Buffer;
  if (resolveTtsLocal(config)) {
    wav = await localTts(ttsUrl, slice, undefined, resolveTtsEngine(config));
  } else {
    const apiKey = resolveTtsApiKey(config);
    if (!apiKey) throw new Error("Voice TTS API key not configured (voice.ttsApiKey)");
    const endpoint = `${openaiAudioBase(ttsUrl)}/audio/speech`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: resolveTtsModel(config),
        input: slice,
        voice: resolveTtsVoice(config),
        response_format: "wav",
      }),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`TTS failed ${res.status}: ${await res.text()}`);
    }
    wav = Buffer.from(await res.arrayBuffer());
  }

  return wavToSipPcm(wav);
}

export async function transcribeSipPcm(config: Claw2Config, pcm8k: Buffer): Promise<string> {
  if (!pcm8k.length) return "";
  const wav = buildWavPcm(pcm8k, SIP_PCM_RATE);
  const sttUrl = resolveVoiceSttUrl(config);
  if (!sttUrl) throw new Error("Voice STT not configured (voice.sttUrl)");

  if (resolveSttLocal(config)) {
    const result = await localStt(sttUrl, wav, "sip.wav");
    return result.text.trim();
  }

  const apiKey = resolveSttApiKey(config);
  if (!apiKey) throw new Error("Voice STT API key not configured (voice.sttApiKey)");
  const endpoint = `${openaiAudioBase(sttUrl)}/audio/transcriptions`;
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "sip.wav");
  form.append("model", resolveSttModel(config));
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(STT_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`STT failed ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { text?: string };
  return typeof data.text === "string" ? data.text.trim() : "";
}
