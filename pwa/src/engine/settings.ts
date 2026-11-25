// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Local app settings — the standalone mobile client has no gateway.
 * Everything lives in localStorage; LLM/tools/voice talk to their HTTP
 * endpoints directly from the device (cloud or LAN).
 */

export type LlmSettings = {
  baseURL: string;
  apiKey: string;
  model: string;
  provider: string;
  enableThinking: boolean;
  systemPromptMode: "full" | "compact";
  maxTokens?: number;
};

export type MemorySettings = {
  enabled: boolean;
  embeddingBaseURL: string;
  embeddingApiKey: string;
  embeddingModel: string;
};

export type SearchSettings = {
  provider: "off" | "tavily" | "searxng" | "other";
  tavilyApiKey: string;
  searxngUrl: string;
  otherUrl: string;
  otherApiKey: string;
};

export type ImagesSettings = {
  sdUrl: string;
  sdApiKey: string;
  sdModel: string;
};

export type VoiceSettings = {
  /** OpenAI-compatible base URL; the request goes to {base}/audio/transcriptions. */
  sttBaseURL: string;
  sttApiKey: string;
  /** Transcription model, e.g. whisper-1 / gpt-4o-mini-transcribe. */
  sttModel: string;
  ttsUrl: string;
  ttsApiKey: string;
  ttsVoice: string;
};

export type ContextSettings = {
  /** Prompt window: last N turns (user+assistant) kept verbatim. */
  maxHistoryTurns: number;
  /** Summarize when the tape grows past this many messages (0 = never). */
  summarizeWhenMessagesAbove: number;
  /** Keep this many recent messages verbatim when summarizing. */
  keepRecentMessages: number;
};

export type HonestySettings = {
  /** Grounding/citation/refusal rules in the system prompt (cheap, always-on recommended). */
  promptPolicy: boolean;
  /** Post-answer verification pass against gathered tool evidence (costs 1 extra LLM call per answer). */
  verifyAnswers: boolean;
};

export type ProviderConfig = {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
  /**
   * Router model (optional, cheap & fast): in router mode it reads the
   * dialogue context + the candidate model list and picks who answers.
   */
  routerModel: string;
  /** Short capability note (e.g. "vision, силён в коде") fed to the dispatcher prompt. */
  notes: string;
  /** Accepts images. Hard router rule: requests with images pick from vision providers only. */
  vision: boolean;
};

export type AppSettings = {
  llm: LlmSettings;
  persona: { full: string; compact: string };
  assistantName: string;
  /** The assistant's face in the chat: a preset emoji or a downscaled data URL. */
  assistantAvatar: string;
  /** Avatar diameter in px (24–96); the emoji scales with it. */
  assistantAvatarSize: number;
  memory: MemorySettings;
  search: SearchSettings;
  images: ImagesSettings;
  voice: VoiceSettings;
  context: ContextSettings;
  honesty: HonestySettings;
  /**
   * First-run wizard completed. The wizard shows only while this is false;
   * breaking the API config later never ejects back into onboarding — the
   * app shows a warning banner and Settings instead.
   */
  onboarded: boolean;
  /**
   * One-shot marker: the legacy llm.* mirror has already been promoted into
   * the provider registry. Without it getSettings would re-derive p_main
   * from the stale llm mirror on every cold start, resurrecting providers
   * the user has deliberately deleted.
   */
  legacyLlmMigrated: boolean;
  /** Saved LLM providers; the active one serves requests. */
  providers: ProviderConfig[];
  activeProviderId: string;
  /**
   * Router mode (meaningful with ≥2 providers): the chat shows a quick
   * provider/model switcher and failed requests fall back down the list.
   */
  routerMode: boolean;
};

const KEY = "claw2_app_settings";

export const DEFAULT_SETTINGS: AppSettings = {
  llm: {
    baseURL: "",
    apiKey: "",
    model: "",
    provider: "openai",
    enableThinking: false,
    systemPromptMode: "full",
  },
  persona: {
    full: "",
    compact: "",
  },
  assistantName: "Claw2",
  assistantAvatar: "🤖",
  assistantAvatarSize: 52,
  memory: {
    enabled: false,
    embeddingBaseURL: "",
    embeddingApiKey: "",
    embeddingModel: "text-embedding-3-small",
  },
  search: {
    provider: "off",
    tavilyApiKey: "",
    searxngUrl: "",
    otherUrl: "",
    otherApiKey: "",
  },
  images: {
    sdUrl: "",
    sdApiKey: "",
    sdModel: "",
  },
  voice: {
    sttBaseURL: "",
    sttApiKey: "",
    sttModel: "whisper-1",
    ttsUrl: "",
    ttsApiKey: "",
    ttsVoice: "alloy",
  },
  context: {
    maxHistoryTurns: 10,
    summarizeWhenMessagesAbove: 12,
    keepRecentMessages: 6,
  },
  honesty: {
    promptPolicy: true,
    verifyAnswers: false,
  },
  onboarded: false,
  legacyLlmMigrated: false,
  providers: [],
  activeProviderId: "",
  routerMode: false,
};

const MAIN_PROVIDER_ID = "p_main";

type Listener = (s: AppSettings) => void;
const listeners = new Set<Listener>();

let cache: AppSettings | null = null;

export function getSettings(): AppSettings {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      cache = {
        ...DEFAULT_SETTINGS,
        ...parsed,
        llm: { ...DEFAULT_SETTINGS.llm, ...(parsed.llm ?? {}) },
        persona: { ...DEFAULT_SETTINGS.persona, ...(parsed.persona ?? {}) },
        memory: { ...DEFAULT_SETTINGS.memory, ...(parsed.memory ?? {}) },
        search: { ...DEFAULT_SETTINGS.search, ...(parsed.search ?? {}) },
        images: { ...DEFAULT_SETTINGS.images, ...(parsed.images ?? {}) },
        voice: { ...DEFAULT_SETTINGS.voice, ...(parsed.voice ?? {}) },
        context: { ...DEFAULT_SETTINGS.context, ...(parsed.context ?? {}) },
        honesty: { ...DEFAULT_SETTINGS.honesty, ...(parsed.honesty ?? {}) },
        providers: Array.isArray(parsed.providers)
          ? parsed.providers.map((p) => ({
              ...p,
              routerModel: p.routerModel ?? "",
              notes: p.notes ?? "",
              vision: p.vision ?? false,
            }))
          : [],
      };
      // Migration: installs configured before the onboarded flag existed must
      // not see the wizard again on update.
      cache.onboarded = parsed.onboarded ?? llmReady(cache);
      cache.legacyLlmMigrated = parsed.legacyLlmMigrated ?? false;
      // Migration: pre-providers installs become the single "Основной" provider.
      // One-shot (legacyLlmMigrated) — the cache memoizes getSettings, so on a
      // fresh install this branch runs BEFORE the wizard saves anything; the
      // wizard therefore writes the registry itself (saveOnboardingConnection),
      // and the marker keeps deleted providers from resurrecting out of the
      // stale llm mirror on later cold starts.
      if (cache.providers.length > 0) {
        cache.legacyLlmMigrated = true;
      } else if (!cache.legacyLlmMigrated && cache.llm.baseURL.trim()) {
        cache.providers = [
          {
            id: MAIN_PROVIDER_ID,
            name: "Основной",
            baseURL: cache.llm.baseURL,
            apiKey: cache.llm.apiKey,
            model: cache.llm.model,
            routerModel: "",
            notes: "",
            vision: false,
          },
        ];
        cache.activeProviderId = MAIN_PROVIDER_ID;
        cache.legacyLlmMigrated = true;
      }
      // Migration: voice.sttUrl (full endpoint) → sttBaseURL (+ model default).
      const legacySttUrl = (parsed.voice as Record<string, unknown> | undefined)?.sttUrl;
      if (typeof legacySttUrl === "string" && legacySttUrl && !cache.voice.sttBaseURL) {
        cache.voice.sttBaseURL = legacySttUrl.replace(/\/audio\/transcriptions\/?$/i, "");
      }
      return cache;
    }
  } catch {
    /* corrupt storage → defaults */
  }
  cache = { ...DEFAULT_SETTINGS };
  return cache;
}

export function saveSettings(patch: DeepPartial<AppSettings>): AppSettings {
  const next = deepMerge(getSettings(), patch) as AppSettings;
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage full — in-memory only */
  }
  for (const l of listeners) l(next);
  return next;
}

export function onSettingsChange(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/**
 * Onboarding commit: the wizard connection must show up in Настройки →
 * Провайдеры immediately, so it goes into the registry as the main provider
 * (upsert), not just into the legacy llm.* mirror. Mirroring into llm.* stays
 * because llm fields are the fallback connection and the embedding fallback.
 */
export function saveOnboardingConnection(conn: {
  baseURL: string;
  apiKey: string;
  model: string;
}): AppSettings {
  const cur = getSettings();
  const providers = cur.providers.slice();
  const idx = providers.findIndex((p) => p.id === MAIN_PROVIDER_ID);
  const prev = idx >= 0 ? providers[idx] : undefined;
  const provider: ProviderConfig = {
    id: MAIN_PROVIDER_ID,
    name: prev?.name || "Основной",
    baseURL: conn.baseURL,
    apiKey: conn.apiKey,
    model: conn.model,
    routerModel: prev?.routerModel ?? "",
    notes: prev?.notes ?? "",
    vision: prev?.vision ?? false,
  };
  if (idx >= 0) providers[idx] = provider;
  else providers.push(provider);
  return saveSettings({
    llm: conn,
    providers,
    activeProviderId: cur.activeProviderId || MAIN_PROVIDER_ID,
    legacyLlmMigrated: true,
  });
}

/** Test hook: drop the in-memory cache so the next getSettings re-reads storage. */
export function resetSettingsCache(): void {
  cache = null;
}

/** True when an LLM endpoint + model are usable (local endpoints may omit the key). */
export function llmReady(s: AppSettings = getSettings()): boolean {
  const { baseURL, model } = resolveLlm(s);
  const base = baseURL.trim();
  if (!base || !model.trim()) return false;
  const key = resolveLlm(s).apiKey.trim();
  if (key) return true;
  return /https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(base);
}

/** Connection the requests go to: the active provider, or legacy llm fields. */
export function resolveLlm(s: AppSettings = getSettings()): {
  baseURL: string;
  apiKey: string;
  model: string;
} {
  const p = s.providers.find((x) => x.id === s.activeProviderId) ?? s.providers[0];
  if (p) return { baseURL: p.baseURL, apiKey: p.apiKey, model: p.model };
  return { baseURL: s.llm.baseURL, apiKey: s.llm.apiKey, model: s.llm.model };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function deepMerge<T extends object>(base: T, patch: DeepPartial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    // Prototype-pollution guard: plain assignment to "__proto__" would set the
    // prototype instead of an own property. Settings are UI-driven today, but
    // this function must stay safe if patch ever comes from parsed storage.
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    const cur = out[k];
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object") {
      out[k] = deepMerge(cur as object, v as object);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}
