// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import type { Claw2Config } from "./types.js";

export type VoiceTtsEngine = "silero" | "xtts" | "moss";

const GPU_ENGINES = new Set<VoiceTtsEngine>(["moss", "xtts"]);

export function resolveTtsEngine(config: Claw2Config): VoiceTtsEngine {
  const v = config.voice?.ttsEngine?.trim().toLowerCase();
  if (v === "xtts" || v === "moss" || v === "silero") return v;
  return "silero";
}

/** MOSS/XTTS on production (CUDA); without GPU - Silero.*/
export function resolveEffectiveTtsEngine(
  config: Claw2Config,
  cudaAvailable = true,
): VoiceTtsEngine {
  const requested = resolveTtsEngine(config);
  if (GPU_ENGINES.has(requested) && !cudaAvailable) return "silero";
  return requested;
}

/**
 * STT URL for web/desktop Voice.
 * Priority: voice.sttUrl → CLAW2_VOICE_STT_URL → telegram.voice (compatibility).
 */
export function resolveVoiceSttUrl(config: Claw2Config): string {
  return (
    config.voice?.sttUrl?.trim() ||
    process.env.CLAW2_VOICE_STT_URL?.trim() ||
    config.channels?.telegram?.voice?.sttUrl?.trim() ||
    ""
  );
}

/**
 * TTS URL for web/desktop Voice.
 * Priority: voice.ttsUrl → CLAW2_VOICE_TTS_URL → telegram.voice (compatibility).
 */
export function resolveVoiceTtsUrl(config: Claw2Config): string {
  return (
    config.voice?.ttsUrl?.trim() ||
    process.env.CLAW2_VOICE_TTS_URL?.trim() ||
    config.channels?.telegram?.voice?.ttsUrl?.trim() ||
    ""
  );
}

function looksLikeOpenAiAudioBase(url: string): boolean {
  const u = url.trim().toLowerCase();
  if (!u) return false;
  if (u.includes("/v1") || u.includes("openai.com")) return true;
  if (/\/stt\/?$/i.test(u) || /\/tts\/?$/i.test(u)) return false;
  return false;
}

function parseLocalEnv(raw: string | undefined): boolean | undefined {
  if (raw == null || raw === "") return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return undefined;
}

/**
 * Local STT (voice service /stt) vs OpenAI-compatible /audio/transcriptions.
 * Explicit voice.sttLocal/CLAW2_VOICE_STT_LOCAL; otherwise URL heuristics.
 */
export function resolveSttLocal(config: Claw2Config): boolean {
  const env = parseLocalEnv(process.env.CLAW2_VOICE_STT_LOCAL);
  if (env !== undefined) return env;
  if (typeof config.voice?.sttLocal === "boolean") return config.voice.sttLocal;
  const url = resolveVoiceSttUrl(config);
  if (!url) return true;
  if (/\/stt\/?$/i.test(url)) return true;
  if (looksLikeOpenAiAudioBase(url)) return false;
  return true;
}

/**
 * Local TTS (voice service /tts) vs OpenAI-compatible /audio/speech.
 */
export function resolveTtsLocal(config: Claw2Config): boolean {
  const env = parseLocalEnv(process.env.CLAW2_VOICE_TTS_LOCAL);
  if (env !== undefined) return env;
  if (typeof config.voice?.ttsLocal === "boolean") return config.voice.ttsLocal;
  const url = resolveVoiceTtsUrl(config);
  if (!url) return true;
  if (/\/tts\/?$/i.test(url)) return true;
  if (looksLikeOpenAiAudioBase(url)) return false;
  return true;
}

export function resolveSttModel(config: Claw2Config): string {
  return (
    config.voice?.sttModel?.trim() ||
    process.env.CLAW2_VOICE_STT_MODEL?.trim() ||
    "whisper-1"
  );
}

export function resolveSttApiKey(config: Claw2Config): string {
  return (
    config.voice?.sttApiKey?.trim() ||
    process.env.CLAW2_VOICE_STT_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    ""
  );
}

export function resolveTtsModel(config: Claw2Config): string {
  return (
    config.voice?.ttsModel?.trim() ||
    process.env.CLAW2_VOICE_TTS_MODEL?.trim() ||
    "tts-1"
  );
}

export function resolveTtsApiKey(config: Claw2Config): string {
  return (
    config.voice?.ttsApiKey?.trim() ||
    process.env.CLAW2_VOICE_TTS_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    ""
  );
}

export function resolveTtsVoice(config: Claw2Config): string {
  return (
    config.voice?.ttsVoice?.trim() ||
    process.env.CLAW2_VOICE_TTS_VOICE?.trim() ||
    "alloy"
  );
}

export type TtsVoiceOption = { id: string; name?: string };

/** OpenAI-compatible voices directory (many providers do not have GET /audio/voices).*/
export function openaiCompatibleTtsVoiceCatalog(model?: string): TtsVoiceOption[] {
  const m = (model || "").toLowerCase();
  const extended =
    m.includes("gpt-4o") || m.includes("gpt-audio") || m.includes("mini-tts");
  const ids = extended
    ? [
        "alloy",
        "ash",
        "ballad",
        "coral",
        "echo",
        "fable",
        "nova",
        "onyx",
        "sage",
        "shimmer",
        "verse",
        "marin",
        "cedar",
      ]
    : ["alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer"];
  return ids.map((id) => ({ id, name: id }));
}

export function localSileroVoiceCatalog(): TtsVoiceOption[] {
  return ["xenia", "baya", "kseniya", "aidar", "eugene"].map((id) => ({ id, name: id }));
}

/**
 * List of TTS votes: first we try the provider API, otherwise the directory.
 * Returns { voices, source: "api" | "catalogue" | "local" }.
 */
export async function fetchTtsVoiceOptions(config: Claw2Config): Promise<{
  voices: TtsVoiceOption[];
  source: "api" | "catalog" | "local";
  current: string;
}> {
  const current = resolveTtsVoice(config);
  if (resolveTtsLocal(config)) {
    const voices = localSileroVoiceCatalog();
    if (current && !voices.some((v) => v.id === current)) {
      voices.unshift({ id: current, name: current });
    }
    return { voices, source: "local", current };
  }

  const ttsUrl = resolveVoiceTtsUrl(config);
  const apiKey = resolveTtsApiKey(config);
  const model = resolveTtsModel(config);
  if (ttsUrl && apiKey) {
    const base = openaiAudioBase(ttsUrl);
    for (const path of ["/audio/voices", "/voices"]) {
      try {
        const res = await fetch(`${base}${path}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) continue;
        const data = (await res.json()) as {
          data?: Array<{ id?: string; name?: string; voice_id?: string }>;
          voices?: Array<{ id?: string; name?: string; voice_id?: string }>;
        };
        const raw = Array.isArray(data.data)
          ? data.data
          : Array.isArray(data.voices)
            ? data.voices
            : [];
        const voices: TtsVoiceOption[] = [];
        for (const item of raw) {
          const id = (item.id || item.voice_id || "").trim();
          if (!id) continue;
          voices.push({ id, name: (item.name || id).trim() });
        }
        if (voices.length > 0) {
          if (current && !voices.some((v) => v.id === current)) {
            voices.unshift({ id: current, name: current });
          }
          return { voices, source: "api", current };
        }
      } catch {
        // try next path / fall through to catalog
      }
    }
  }

  const voices = openaiCompatibleTtsVoiceCatalog(model);
  if (current && !voices.some((v) => v.id === current)) {
    voices.unshift({ id: current, name: current });
  }
  return { voices, source: "catalog", current };
}

/** Base URL normalization for OpenAI-compatible audio API (like openaiImagesBase).*/
export function openaiAudioBase(raw: string): string {
  let u = raw.trim().replace(/\/+$/, "");
  u = u.replace(/\/audio\/(transcriptions|translations|speech)$/i, "");
  if (!/\/v1$/i.test(u)) u = `${u}/v1`;
  return u;
}
