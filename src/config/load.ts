import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import dotenv from "dotenv";
import type { Claw2Config, SipMediaBackendMode, SipRealtimeConfig, SipRealtimeProvider } from "./types.js";
import {
  defaultAgentsDirUnderState,
  defaultUploadsDirUnderState,
  getClaw2StateDir,
  usesHomeStateLayout,
} from "./state-dir.js";

let envLoaded = false;
function ensureEnvLoaded(): void {
  if (!envLoaded) {
    dotenv.config({ path: resolve(process.cwd(), ".env") });
    envLoaded = true;
  }
}

import { normalizeContainerServiceUrls } from "./container-net.js";

const ENV_REF_PREFIX = "env:";

function resolveEnvRef(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "");
  const trimmed = value.trim();
  if (!trimmed.startsWith(ENV_REF_PREFIX)) return trimmed;
  const varName = trimmed.slice(ENV_REF_PREFIX.length).trim();
  const envVal = process.env[varName];
  return envVal ?? "";
}

function resolveObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out[k] = resolveObject(v as Record<string, unknown>);
    } else if (typeof v === "string") {
      out[k] = resolveEnvRef(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function getConfigPath(): string {
  const explicit = process.env.CLAW2_CONFIG_PATH?.trim();
  if (explicit) return resolve(explicit);
  const stateDir = process.env.CLAW2_STATE_DIR?.trim() || resolve(process.cwd(), ".claw2");
  return resolve(stateDir, "claw2.yaml");
}

function parseBoolEnv(raw: string | undefined): boolean | undefined {
  if (raw == null || raw === "") return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
}

function normalizeSipRealtime(raw: unknown): SipRealtimeConfig {
  const o =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const providerRaw = (
    process.env.CLAW2_SIP_REALTIME_PROVIDER?.trim() ||
    (typeof o.provider === "string" ? o.provider.trim().toLowerCase() : "")
  );
  const provider: SipRealtimeProvider =
    providerRaw === "pipeline" ||
    providerRaw === "yandex" ||
    providerRaw === "openai" ||
    providerRaw === "xai" ||
    providerRaw === "off"
      ? providerRaw
      : "off";

  const apiKey =
    process.env.CLAW2_SIP_REALTIME_API_KEY?.trim() ||
    (typeof o.apiKey === "string" ? o.apiKey.trim() || undefined : undefined);
  const folderId =
    process.env.CLAW2_SIP_REALTIME_FOLDER_ID?.trim() ||
    process.env.YANDEX_FOLDER_ID?.trim() ||
    (typeof o.folderId === "string" ? o.folderId.trim() || undefined : undefined);
  const iamToken =
    process.env.CLAW2_SIP_REALTIME_IAM_TOKEN?.trim() ||
    process.env.YANDEX_IAM_TOKEN?.trim() ||
    (typeof o.iamToken === "string" ? o.iamToken.trim() || undefined : undefined);
  const model =
    process.env.CLAW2_SIP_REALTIME_MODEL?.trim() ||
    (typeof o.model === "string" ? o.model.trim() || undefined : undefined);
  const voice =
    process.env.CLAW2_SIP_REALTIME_VOICE?.trim() ||
    (typeof o.voice === "string" ? o.voice.trim() || undefined : undefined);
  const baseURL =
    process.env.CLAW2_SIP_REALTIME_BASE_URL?.trim() ||
    (typeof o.baseURL === "string" ? o.baseURL.trim() || undefined : undefined);

  const sampleRateEnv = process.env.CLAW2_SIP_REALTIME_SAMPLE_RATE?.trim();
  const sampleRateRaw =
    sampleRateEnv && /^\d+$/.test(sampleRateEnv)
      ? Number(sampleRateEnv)
      : typeof o.sampleRate === "number"
        ? o.sampleRate
        : undefined;
  const sampleRate =
    typeof sampleRateRaw === "number" && sampleRateRaw > 0 && Number.isFinite(sampleRateRaw)
      ? Math.floor(sampleRateRaw)
      : undefined;

  const useLlmApiKey =
    parseBoolEnv(process.env.CLAW2_SIP_REALTIME_USE_LLM_API_KEY) ??
    (typeof o.useLlmApiKey === "boolean" ? o.useLlmApiKey : undefined);

  return {
    provider,
    ...(apiKey ? { apiKey } : {}),
    ...(useLlmApiKey !== undefined ? { useLlmApiKey } : {}),
    ...(folderId ? { folderId } : {}),
    ...(iamToken ? { iamToken } : {}),
    ...(model ? { model } : {}),
    ...(voice ? { voice } : {}),
    ...(sampleRate !== undefined ? { sampleRate } : {}),
    ...(baseURL ? { baseURL } : {}),
  };
}

function normalizeSipMediaBackend(raw: unknown): SipMediaBackendMode {
  const fromEnv = process.env.CLAW2_SIP_MEDIA_BACKEND?.trim().toLowerCase();
  const fromYaml = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const v = fromEnv || fromYaml;
  if (v === "node" || v === "sidecar" || v === "auto") return v;
  return "auto";
}

function normalizeHostFs(
  raw: unknown
): NonNullable<Claw2Config["sandbox"]>["hostFs"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as {
    mode?: string;
    read?: unknown;
    write?: unknown;
  };
  const modeRaw = typeof o.mode === "string" ? o.mode.trim().toLowerCase() : "";
  const mode =
    modeRaw === "full" || modeRaw === "allowlist" || modeRaw === "default"
      ? (modeRaw as "full" | "allowlist" | "default")
      : undefined;
  const read = Array.isArray(o.read)
    ? o.read.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim())
    : undefined;
  const write = Array.isArray(o.write)
    ? o.write.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim())
    : undefined;
  if (!mode && !(read && read.length) && !(write && write.length)) return undefined;
  const resolvedMode = mode ?? ((read?.length || write?.length) ? "allowlist" : "default");
  return {
    mode: resolvedMode,
    ...(read?.length ? { read } : {}),
    ...(write?.length ? { write } : {}),
  };
}

/**
 * Loads config from YAML. Secrets are substituted from env (values ​​like env:VAR_NAME).
 */
export function loadConfig(overridePath?: string): Claw2Config {
  ensureEnvLoaded();
  const path = overridePath ?? getConfigPath();
  let raw: Record<string, unknown> = {};
  try {
    const content = readFileSync(path, "utf-8");
    raw = (parseYaml(content) as Record<string, unknown>) ?? {};
  } catch (err) {
    console.error(`[config] Failed to load ${path}:`, err instanceof Error ? err.message : String(err));
  }
  if (Object.keys(raw).length === 0) {
    console.error("[config] Config empty or invalid, using defaults. Check path and YAML syntax.");
  }
  const resolved = resolveObject(raw) as Partial<Claw2Config>;
  const config = mergeConfig(resolved);
  // Container delivery: operator-written loopback URLs (127.0.0.1/localhost)
  // point at host services the container cannot reach — map them once, at
  // load time, for every consumer and every hot-reload.
  normalizeContainerServiceUrls(config);
  return config;
}

function mergeConfig(partial: Partial<Claw2Config>): Claw2Config {
  const defaults: Partial<Claw2Config> = {
    llm: { provider: "openai", model: "gpt-4o-mini", baseURL: "http://127.0.0.1:1234" },
    sandbox: { image: "node:20-alpine", timeoutMs: 60_000 },
    memory: {
      enabled: false,
      backend: "memory",
      maxChunks: 500,
      maxRecallChunks: 5,
      chroma: { url: "http://localhost:8000", collectionName: "claw2_memory" },
    },
    insights: {
      enabled: true,
      mode: "ask",
      minScore: 0.72,
      maxCandidates: 1,
      cooldownSec: 300,
      unresolvedMinAgeSec: 86400,
      budgetMs: 350,
      useMemory: true,
      useProjectDigests: true,
      useUnresolvedThreads: true,
      cheapPass: { enabled: true, maxTokens: 180 },
    },
    gateway: { port: 3000, auth: { enabled: false } },
  };

  let gateway = partial.gateway
    ? {
        ...defaults.gateway,
        ...partial.gateway,
        auth: { ...defaults.gateway?.auth, ...partial.gateway?.auth },
      }
    : { ...defaults.gateway };

  const bindEnv = process.env.CLAW2_GATEWAY_BIND?.trim();
  if (bindEnv) {
    gateway = { ...gateway, bind: bindEnv };
  } else if (process.env.CLAW2_DESKTOP === "1" && !gateway?.bind?.trim()) {
    // Desktop single-user: never expose unauthenticated API on LAN by default
    gateway = { ...gateway, bind: "127.0.0.1" };
  }

  const channels = partial.channels
    ? {
        telegram: {
          enabled: partial.channels.telegram?.enabled ?? false,
          botToken:
            (partial.channels.telegram?.botToken as string | undefined)?.trim() ||
            process.env.TELEGRAM_BOT_TOKEN ||
            "",
          proxyUrl:
            (partial.channels.telegram?.proxyUrl as string | undefined)?.trim() ||
            process.env.TELEGRAM_PROXY_URL ||
            "",
          apiBaseUrl:
            (partial.channels.telegram?.apiBaseUrl as string | undefined)?.trim() ||
            process.env.TELEGRAM_API_BASE_URL ||
            "",
          ownerId:
            typeof partial.channels.telegram?.ownerId === "number" && partial.channels.telegram.ownerId > 0
              ? partial.channels.telegram.ownerId
              : process.env.TELEGRAM_OWNER_ID
                ? parseInt(process.env.TELEGRAM_OWNER_ID, 10)
                : undefined,
          allowlistDbPath:
            (partial.channels.telegram?.allowlistDbPath as string | undefined)?.trim() ||
            process.env.TELEGRAM_ALLOWLIST_DB_PATH ||
            "",
          voice:
            partial.channels.telegram?.voice && typeof partial.channels.telegram.voice === "object"
              ? {
                  sttUrl:
                    (process.env.CLAW2_VOICE_STT_URL?.trim() ||
                      (partial.channels.telegram.voice as { sttUrl?: string }).sttUrl?.trim()) ??
                    "",
                  ttsUrl:
                    (process.env.CLAW2_VOICE_TTS_URL?.trim() ||
                      (partial.channels.telegram.voice as { ttsUrl?: string }).ttsUrl?.trim()) ??
                    "",
                  replyWithVoice: (partial.channels.telegram.voice as { replyWithVoice?: boolean }).replyWithVoice,
                  ttsMaxChars: (partial.channels.telegram.voice as { ttsMaxChars?: number }).ttsMaxChars,
                }
              : undefined,
        },
        vk: {
          enabled: partial.channels.vk?.enabled ?? false,
          accessToken:
            (partial.channels.vk?.accessToken as string | undefined)?.trim() ||
            process.env.VK_ACCESS_TOKEN ||
            "",
          groupId:
            typeof partial.channels.vk?.groupId === "number" && partial.channels.vk.groupId > 0
              ? partial.channels.vk.groupId
              : (process.env.VK_GROUP_ID && parseInt(process.env.VK_GROUP_ID, 10)) || 0,
          voice:
            partial.channels.vk?.voice && typeof partial.channels.vk.voice === "object"
              ? {
                  sttUrl: (partial.channels.vk.voice as { sttUrl?: string }).sttUrl?.trim(),
                  ttsUrl: (partial.channels.vk.voice as { ttsUrl?: string }).ttsUrl?.trim(),
                  replyWithVoice: (partial.channels.vk.voice as { replyWithVoice?: boolean }).replyWithVoice,
                  ttsMaxChars: (partial.channels.vk.voice as { ttsMaxChars?: number }).ttsMaxChars,
                }
              : undefined,
        },
      }
    : undefined;

  const scheduler = partial.scheduler
    ? { enabled: partial.scheduler.enabled ?? false }
    : undefined;

  const llmBridgeUrl =
    process.env.CLAW2_LLM_BRIDGE_URL?.trim() || partial.llmBridge?.url?.trim();
  const llmBridge = partial.llmBridge || llmBridgeUrl
    ? {
        enabled: partial.llmBridge?.enabled ?? false,
        url: llmBridgeUrl || partial.llmBridge?.url,
        agentId:
          process.env.CLAW2_LLM_BRIDGE_AGENT_ID?.trim() || partial.llmBridge?.agentId?.trim(),
        conversationId:
          process.env.CLAW2_LLM_BRIDGE_CONVERSATION_ID?.trim() ||
          partial.llmBridge?.conversationId?.trim() ||
          "default",
        displayName: partial.llmBridge?.displayName?.trim(),
        participantLabels:
          partial.llmBridge?.participantLabels &&
          typeof partial.llmBridge.participantLabels === "object"
            ? partial.llmBridge.participantLabels
            : undefined,
        peerId: process.env.CLAW2_LLM_BRIDGE_PEER_ID?.trim() || partial.llmBridge?.peerId?.trim(),
        token:
          process.env.CLAW2_LLM_BRIDGE_TOKEN?.trim() || partial.llmBridge?.token?.trim(),
        autoReply: partial.llmBridge?.autoReply ?? false,
        autoReplyMode:
          process.env.CLAW2_LLM_BRIDGE_AUTO_REPLY_MODE?.trim() === "mention" ||
          partial.llmBridge?.autoReplyMode === "mention"
            ? "mention"
            : "all",
        pollIntervalMs: partial.llmBridge?.pollIntervalMs ?? 3000,
        sessionId: partial.llmBridge?.sessionId?.trim(),
        peerLabel: partial.llmBridge?.peerLabel?.trim(),
      }
    : undefined;

  const homeLayout = usesHomeStateLayout();
  const defaultUploadsHost = homeLayout ? defaultUploadsDirUnderState() : "agents/uploads";
  const uploads = partial.uploads
    ? {
        hostPath: partial.uploads.hostPath?.trim() || defaultUploadsHost,
        sandboxPath: partial.uploads.sandboxPath?.trim() || "/app/uploads",
      }
    : { hostPath: defaultUploadsHost, sandboxPath: "/app/uploads" };

  const workspace = partial.workspace
    ? resolve(partial.workspace)
    : homeLayout
      ? getClaw2StateDir()
      : resolve(process.cwd());
  const allowlist = partial.allowlist
    ? { paths: Array.isArray(partial.allowlist.paths) ? partial.allowlist.paths : [] }
    : { paths: [] };
  const skills = partial.skills
    ? { allowlist: Array.isArray(partial.skills.allowlist) ? partial.skills.allowlist : [] }
    : undefined;
  const disabledAgents = Array.isArray(partial.disabledAgents)
    ? partial.disabledAgents
        .map((s) => String(s ?? "").trim())
        .filter(Boolean)
        .map((s) => (s.endsWith(".js") ? s : `${s}.js`))
    : undefined;

  const tools = partial.tools
    ? {
        search:
          partial.tools?.search && typeof partial.tools.search === "object"
            ? {
                provider:
                  partial.tools.search.provider === "tavily" ||
                  partial.tools.search.provider === "searxng" ||
                  partial.tools.search.provider === "other" ||
                  partial.tools.search.provider === "auto"
                    ? partial.tools.search.provider
                    : undefined,
                useLlmInWeb:
                  typeof partial.tools.search.useLlmInWeb === "boolean"
                    ? partial.tools.search.useLlmInWeb
                    : undefined,
                browserEngines: Array.isArray(partial.tools.search.browserEngines)
                  ? partial.tools.search.browserEngines
                      .filter(
                        (e): e is { id: string; name: string; urlTemplate: string; enabled?: boolean } =>
                          !!e &&
                          typeof e === "object" &&
                          typeof (e as { id?: unknown }).id === "string" &&
                          typeof (e as { name?: unknown }).name === "string" &&
                          typeof (e as { urlTemplate?: unknown }).urlTemplate === "string"
                      )
                      .map((e) => ({
                        id: String(e.id).trim(),
                        name: String(e.name).trim(),
                        urlTemplate: String(e.urlTemplate).trim(),
                        enabled: e.enabled !== false,
                      }))
                      .filter((e) => e.id && e.name && e.urlTemplate.includes("{query}"))
                  : undefined,
              }
            : undefined,
        tavily: partial.tools?.tavily,
        searxng:
          partial.tools?.searxng && typeof partial.tools.searxng === "object"
            ? {
                url:
                  typeof partial.tools.searxng.url === "string"
                    ? partial.tools.searxng.url.trim() || undefined
                    : undefined,
                apiKey:
                  typeof partial.tools.searxng.apiKey === "string"
                    ? partial.tools.searxng.apiKey.trim() || undefined
                    : undefined,
                enabled: partial.tools.searxng.enabled,
              }
            : undefined,
        other:
          partial.tools?.other && typeof partial.tools.other === "object"
            ? {
                url:
                  typeof partial.tools.other.url === "string"
                    ? partial.tools.other.url.trim() || undefined
                    : undefined,
                apiKey:
                  typeof partial.tools.other.apiKey === "string"
                    ? partial.tools.other.apiKey.trim() || undefined
                    : undefined,
                enabled: partial.tools.other.enabled,
              }
            : undefined,
        sdUrl: partial.tools?.sdUrl,
        sdEnabled: partial.tools?.sdEnabled,
        sdModel: typeof partial.tools?.sdModel === "string" ? partial.tools.sdModel.trim() || undefined : partial.tools?.sdModel,
        sdApiKey: typeof partial.tools?.sdApiKey === "string" ? partial.tools.sdApiKey.trim() || undefined : partial.tools?.sdApiKey,
        sdApi:
          partial.tools?.sdApi === "txt2img" || partial.tools?.sdApi === "openai" || partial.tools?.sdApi === "auto"
            ? partial.tools.sdApi
            : undefined,
        webFetch: {
          timeoutMs: partial.tools?.webFetch?.timeoutMs ?? 15_000,
          maxBodyBytes: partial.tools?.webFetch?.maxBodyBytes ?? 1_000_000,
          maxContextChars: partial.tools?.webFetch?.maxContextChars ?? 8_000,
        },
        message: {
          allowedWebhooks: partial.tools?.message?.allowedWebhooks ?? [],
          policy: (partial.tools?.message?.policy as "allow_one" | "require_confirmation" | "deny_bulk") ?? "allow_one",
        },
      }
    : undefined;

  const audit = partial.audit
    ? { logPath: partial.audit.logPath, logFormat: (partial.audit.logFormat as "text" | "json") ?? "text" }
    : undefined;

  const security = partial.security
    ? {
        lethalTrifecta: {
          enabled: partial.security.lethalTrifecta?.enabled ?? false,
          action: (partial.security.lethalTrifecta?.action as "warn" | "block") ?? "warn",
        },
      }
    : undefined;

  const secrets = partial.secrets
    ? {
        allowlist: Array.isArray(partial.secrets.allowlist) ? partial.secrets.allowlist : [],
        requireConfirmation: partial.secrets.requireConfirmation ?? false,
      }
    : undefined;

  let sandboxMerged = partial.sandbox
    ? {
        ...defaults.sandbox,
        ...partial.sandbox,
        elevatedAllowed: partial.sandbox.elevatedAllowed ?? false,
        hostFs: normalizeHostFs(partial.sandbox.hostFs),
      }
    : { ...defaults.sandbox };

  // Desktop single-user: host sandbox by default (no Docker Desktop required).
  if (process.env.CLAW2_DESKTOP === "1") {
    sandboxMerged = {
      ...sandboxMerged,
      useDocker: partial.sandbox?.useDocker ?? false,
      elevatedAllowed: partial.sandbox?.elevatedAllowed ?? false,
      hostFs: normalizeHostFs(partial.sandbox?.hostFs ?? sandboxMerged.hostFs),
    };
  }

  const llmMerged = { ...defaults.llm, ...partial.llm };

  // Desktop first-run: do not inherit server default http://127.0.0.1:1234 —
  // that looked "configured" (local, no key) and skipped LLM onboarding.
  if (
    process.env.CLAW2_DESKTOP === "1" &&
    !partial.llm?.baseURL?.trim() &&
    !process.env.OPENAI_BASE_URL?.trim()
  ) {
    delete (llmMerged as { baseURL?: string }).baseURL;
  }

  const agentSelection = {
    enabled: partial.agentSelection?.enabled ?? false,
    dbPath: partial.agentSelection?.dbPath,
    runsPerVersion: partial.agentSelection?.runsPerVersion ?? 5,
    maxVersionsPerTask: partial.agentSelection?.maxVersionsPerTask ?? 3,
    codingModel: partial.agentSelection?.codingModel
      ? {
          model: partial.agentSelection.codingModel.model,
          baseURL: partial.agentSelection.codingModel.baseURL?.trim() || llmMerged?.baseURL,
          apiKey: partial.agentSelection.codingModel.apiKey ?? llmMerged?.apiKey,
        }
      : undefined,
  };

  const rawMaxSub = partial.coding?.maxSubagents;
  const maxSubagents =
    typeof rawMaxSub === "number" && Number.isFinite(rawMaxSub)
      ? Math.max(1, Math.floor(rawMaxSub))
      : 3;
  const coding = {
    maxSubagents,
    smokeArgs: Array.isArray(partial.coding?.smokeArgs)
      ? partial.coding!.smokeArgs!.map((s) => String(s))
      : undefined,
  };

  const ra = partial.remoteAccess;
  const MASK_TOKEN = "***";
  const remoteAccess =
    ra && typeof ra === "object"
      ? {
          accessToken: (() => {
            const t = typeof ra.accessToken === "string" ? ra.accessToken.trim() : "";
            if (!t || t === MASK_TOKEN) return undefined;
            return t;
          })(),
          ddns:
            ra.ddns && typeof ra.ddns === "object"
              ? {
                  provider: "duckdns" as const,
                  enabled: ra.ddns.enabled === true,
                  domain:
                    typeof ra.ddns.domain === "string" ? ra.ddns.domain.trim() || undefined : undefined,
                  token: (() => {
                    const t = typeof ra.ddns.token === "string" ? ra.ddns.token.trim() : "";
                    if (!t || t === MASK_TOKEN) return undefined;
                    return t;
                  })(),
                  updateIntervalMinutes: (() => {
                    const n = ra.ddns.updateIntervalMinutes;
                    if (typeof n === "number" && Number.isFinite(n)) return Math.max(5, Math.floor(n));
                    return undefined;
                  })(),
                }
              : undefined,
          tls:
            ra.tls && typeof ra.tls === "object"
              ? {
                  enabled: ra.tls.enabled === true,
                  email:
                    typeof ra.tls.email === "string" ? ra.tls.email.trim() || undefined : undefined,
                  staging: ra.tls.staging === true,
                  dnsPropagationMs: (() => {
                    const n = ra.tls.dnsPropagationMs;
                    if (typeof n === "number" && Number.isFinite(n) && n >= 0) return Math.floor(n);
                    return undefined;
                  })(),
                  listenEnabled: ra.tls.listenEnabled === true,
                  listenPort: (() => {
                    const n = ra.tls.listenPort;
                    if (typeof n === "number" && Number.isFinite(n) && n > 0) {
                      return Math.min(65535, Math.floor(n));
                    }
                    return undefined;
                  })(),
                  openOnTrayHide: ra.tls.openOnTrayHide === true,
                  /** default on — PWA behind NAT */
                  upnp: ra.tls.upnp !== false,
                }
              : undefined,
        }
      : undefined;

  const memoryMerged = partial.memory
    ? {
        ...defaults.memory,
        ...partial.memory,
        chroma:
          partial.memory.chroma ?
            { ...defaults.memory?.chroma, ...partial.memory.chroma }
          : defaults.memory?.chroma,
      }
    : { ...defaults.memory };

  const insightsMerged = partial.insights
    ? {
        ...defaults.insights,
        ...partial.insights,
        cheapPass: {
          ...defaults.insights?.cheapPass,
          ...partial.insights.cheapPass,
        },
      }
    : { ...defaults.insights };

  const backendEnv = process.env.CLAW2_MEMORY_BACKEND?.trim().toLowerCase();
  if (backendEnv === "sqlite" || backendEnv === "chroma" || backendEnv === "memory") {
    memoryMerged.backend = backendEnv;
  }
  const embProviderEnv = process.env.CLAW2_MEMORY_EMBEDDING_PROVIDER?.trim().toLowerCase();
  if (embProviderEnv === "local" || embProviderEnv === "http") {
    memoryMerged.embeddingProvider = embProviderEnv;
  }
  const sqlitePathEnv = process.env.CLAW2_MEMORY_SQLITE_PATH?.trim();
  if (sqlitePathEnv) {
    memoryMerged.sqlitePath = sqlitePathEnv;
  }
  const chromaUrlEnv = process.env.CLAW2_MEMORY_CHROMA_URL?.trim();
  if (chromaUrlEnv) {
    memoryMerged.chroma = { ...memoryMerged.chroma, url: chromaUrlEnv };
  }
  const embeddingBaseUrlEnv = process.env.CLAW2_MEMORY_EMBEDDING_BASE_URL?.trim();
  if (embeddingBaseUrlEnv) {
    memoryMerged.embeddingBaseURL = embeddingBaseUrlEnv;
  }
  const embeddingModelEnv = process.env.CLAW2_MEMORY_EMBEDDING_MODEL?.trim();
  if (embeddingModelEnv) {
    memoryMerged.embeddingModel = embeddingModelEnv;
  }

  const vision = partial.vision
    ? {
        enabled: partial.vision.enabled ?? false,
        superuserIds: Array.isArray(partial.vision.superuserIds) ? partial.vision.superuserIds : [],
        recognizeUrl: typeof partial.vision.recognizeUrl === "string" ? partial.vision.recognizeUrl.trim() || undefined : undefined,
      }
    : { enabled: false, superuserIds: [] as string[], recognizeUrl: undefined as string | undefined };

  const sipPortRaw = partial.sip?.port;
  const sipLocalPortRaw = partial.sip?.localPort;
  const sipExpiresRaw = partial.sip?.registerExpires;
  const hasSipRealtimeEnv = !!(
    process.env.CLAW2_SIP_REALTIME_PROVIDER?.trim() ||
    process.env.CLAW2_SIP_REALTIME_API_KEY?.trim() ||
    process.env.CLAW2_SIP_REALTIME_FOLDER_ID?.trim()
  );
  const sip =
    partial.sip ||
    process.env.CLAW2_SIP_SERVER?.trim() ||
    process.env.CLAW2_SIP_USER?.trim() ||
    hasSipRealtimeEnv
      ? {
          enabled: partial.sip?.enabled === true || process.env.CLAW2_SIP_ENABLED?.trim() === "1",
          server:
            process.env.CLAW2_SIP_SERVER?.trim() ||
            (typeof partial.sip?.server === "string" ? partial.sip.server.trim() || undefined : undefined),
          port:
            process.env.CLAW2_SIP_PORT && /^\d+$/.test(process.env.CLAW2_SIP_PORT)
              ? Number(process.env.CLAW2_SIP_PORT)
              : typeof sipPortRaw === "number"
                ? sipPortRaw
                : undefined,
          domain:
            process.env.CLAW2_SIP_DOMAIN?.trim() ||
            (typeof partial.sip?.domain === "string" ? partial.sip.domain.trim() || undefined : undefined),
          user:
            process.env.CLAW2_SIP_USER?.trim() ||
            (typeof partial.sip?.user === "string" ? partial.sip.user.trim() || undefined : undefined),
          password:
            process.env.CLAW2_SIP_PASSWORD?.trim() ||
            (typeof partial.sip?.password === "string" ? partial.sip.password.trim() || undefined : undefined),
          displayName:
            typeof partial.sip?.displayName === "string"
              ? partial.sip.displayName.trim() || undefined
              : undefined,
          localPort:
            process.env.CLAW2_SIP_LOCAL_PORT && /^\d+$/.test(process.env.CLAW2_SIP_LOCAL_PORT)
              ? Number(process.env.CLAW2_SIP_LOCAL_PORT)
              : typeof sipLocalPortRaw === "number"
                ? sipLocalPortRaw
                : undefined,
          publicAddress:
            process.env.CLAW2_SIP_PUBLIC_ADDRESS?.trim() ||
            (typeof partial.sip?.publicAddress === "string"
              ? partial.sip.publicAddress.trim() || undefined
              : undefined),
          registerExpires: typeof sipExpiresRaw === "number" ? sipExpiresRaw : undefined,
          autoAnswer: partial.sip?.autoAnswer === true,
          operatorUri:
            process.env.CLAW2_SIP_OPERATOR_URI?.trim() ||
            (typeof partial.sip?.operatorUri === "string"
              ? partial.sip.operatorUri.trim() || undefined
              : undefined),
          // Default provider off - the config without realtime remains valid (batch pipeline).
          realtime: normalizeSipRealtime(partial.sip?.realtime),
          mediaBackend: normalizeSipMediaBackend(partial.sip?.mediaBackend),
          sidecarPath:
            process.env.CLAW2_SIP_SIDECAR_PATH?.trim() ||
            (typeof partial.sip?.sidecarPath === "string"
              ? partial.sip.sidecarPath.trim() || undefined
              : undefined),
        }
      : undefined;

  const yamlTtsEngine =
    typeof partial.voice?.ttsEngine === "string" ? partial.voice.ttsEngine.trim().toLowerCase() : "";
  const ttsEngineRaw =
    process.env.CLAW2_VOICE_TTS_ENGINE?.trim().toLowerCase() || yamlTtsEngine;
  const voiceSttUrl =
    typeof partial.voice?.sttUrl === "string" ? partial.voice.sttUrl.trim() || undefined : undefined;
  const voiceTtsUrl =
    typeof partial.voice?.ttsUrl === "string" ? partial.voice.ttsUrl.trim() || undefined : undefined;
  const voiceSttModel =
    process.env.CLAW2_VOICE_STT_MODEL?.trim() ||
    (typeof partial.voice?.sttModel === "string" ? partial.voice.sttModel.trim() || undefined : undefined);
  const voiceTtsModel =
    process.env.CLAW2_VOICE_TTS_MODEL?.trim() ||
    (typeof partial.voice?.ttsModel === "string" ? partial.voice.ttsModel.trim() || undefined : undefined);
  const voiceSttApiKey =
    process.env.CLAW2_VOICE_STT_API_KEY?.trim() ||
    (typeof partial.voice?.sttApiKey === "string" ? partial.voice.sttApiKey.trim() || undefined : undefined);
  const voiceTtsApiKey =
    process.env.CLAW2_VOICE_TTS_API_KEY?.trim() ||
    (typeof partial.voice?.ttsApiKey === "string" ? partial.voice.ttsApiKey.trim() || undefined : undefined);
  const voiceTtsVoice =
    process.env.CLAW2_VOICE_TTS_VOICE?.trim() ||
    (typeof partial.voice?.ttsVoice === "string" ? partial.voice.ttsVoice.trim() || undefined : undefined);
  const voiceSttLocal =
    parseBoolEnv(process.env.CLAW2_VOICE_STT_LOCAL) ??
    (typeof partial.voice?.sttLocal === "boolean" ? partial.voice.sttLocal : undefined);
  const voiceTtsLocal =
    parseBoolEnv(process.env.CLAW2_VOICE_TTS_LOCAL) ??
    (typeof partial.voice?.ttsLocal === "boolean" ? partial.voice.ttsLocal : undefined);
  const voice =
    partial.voice ||
    ttsEngineRaw ||
    voiceSttUrl ||
    voiceTtsUrl ||
    voiceSttModel ||
    voiceTtsModel ||
    voiceSttApiKey ||
    voiceTtsApiKey ||
    voiceTtsVoice ||
    voiceSttLocal !== undefined ||
    voiceTtsLocal !== undefined
      ? {
          ...partial.voice,
          sttUrl: voiceSttUrl,
          ttsUrl: voiceTtsUrl,
          sttModel: voiceSttModel,
          ttsModel: voiceTtsModel,
          sttApiKey: voiceSttApiKey,
          ttsApiKey: voiceTtsApiKey,
          ttsVoice: voiceTtsVoice,
          ...(voiceSttLocal !== undefined ? { sttLocal: voiceSttLocal } : {}),
          ...(voiceTtsLocal !== undefined ? { ttsLocal: voiceTtsLocal } : {}),
          ttsEngine:
            ttsEngineRaw === "xtts" || ttsEngineRaw === "moss" || ttsEngineRaw === "silero"
              ? (ttsEngineRaw as "silero" | "xtts" | "moss")
              : partial.voice?.ttsEngine,
        }
      : undefined;

  const assistantMdPath =
    process.env.CLAW2_ASSISTANT_MD?.trim() ||
    (typeof partial.assistant?.mdPath === "string" ? partial.assistant.mdPath.trim() || undefined : undefined);
  const personaMarkdown =
    typeof partial.assistant?.personaMarkdown === "string"
      ? partial.assistant.personaMarkdown.trim() || undefined
      : undefined;
  const assistant =
    assistantMdPath || personaMarkdown || partial.assistant
      ? {
          ...(assistantMdPath ? { mdPath: resolve(assistantMdPath) } : {}),
          ...(personaMarkdown ? { personaMarkdown } : {}),
        }
      : undefined;

  return {
    llm: llmMerged,
    assistant,
    agentsDir: partial.agentsDir
      ? resolve(partial.agentsDir)
      : homeLayout
        ? defaultAgentsDirUnderState()
        : resolve(process.cwd(), "agents"),
    disabledAgents,
    orchestrator: partial.orchestrator,
    sandbox: sandboxMerged,
    memory: memoryMerged,
    insights: insightsMerged,
    gateway,
    channels,
    voice,
    sip,
    vision,
    scheduler,
    llmBridge,
    uploads,
    workspace,
    allowlist,
    skills,
    tools,
    audit,
    security,
    secrets,
    agentSelection,
    coding,
    remoteAccess,
    privacy: partial.privacy
      ? {
          enabled: partial.privacy.enabled === true,
          applyToLocal: partial.privacy.applyToLocal === true,
          multimodalBackend:
            partial.privacy.multimodalBackend === "off" ||
            partial.privacy.multimodalBackend === "sidecar" ||
            partial.privacy.multimodalBackend === "auto"
              ? partial.privacy.multimodalBackend
              : "auto",
          multimodalMaxSizeMb:
            typeof partial.privacy.multimodalMaxSizeMb === "number"
              ? partial.privacy.multimodalMaxSizeMb
              : undefined,
          ocrTimeoutSeconds:
            typeof partial.privacy.ocrTimeoutSeconds === "number"
              ? partial.privacy.ocrTimeoutSeconds
              : undefined,
          ocrLowConfRatio:
            typeof partial.privacy.ocrLowConfRatio === "number"
              ? partial.privacy.ocrLowConfRatio
              : undefined,
          ocrSidecarPath:
            typeof partial.privacy.ocrSidecarPath === "string"
              ? partial.privacy.ocrSidecarPath.trim() || null
              : partial.privacy.ocrSidecarPath === null
                ? null
                : undefined,
          customRules: Array.isArray(partial.privacy.customRules)
            ? partial.privacy.customRules
                .filter((r) => r && typeof r === "object")
                .map((r, i) => ({
                  id: typeof r.id === "string" && r.id.trim() ? r.id.trim() : `rule_${i + 1}`,
                  name: typeof r.name === "string" ? r.name.trim().slice(0, 64) : "RULE",
                  ruleType: r.ruleType === "regex" ? ("regex" as const) : ("keyword" as const),
                  pattern: typeof r.pattern === "string" ? r.pattern.slice(0, 256) : "",
                  caseSensitive: r.caseSensitive === true,
                  wholeWord: r.wholeWord === true,
                  enabled: r.enabled !== false,
                  sortOrder: typeof r.sortOrder === "number" ? r.sortOrder : i,
                }))
                .filter((r) => r.pattern)
                .slice(0, 100)
            : undefined,
        }
      : undefined,
  } as Claw2Config;
}
