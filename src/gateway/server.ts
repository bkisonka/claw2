// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, lstatSync, readdirSync, unlinkSync, constants as fsConstants } from "node:fs";
import { isIP } from "node:net";
import { resolveCorsAllowOrigin } from "./cors.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join, relative, resolve, extname, isAbsolute } from "node:path";
import { saveUploadedDocuments, type IncomingDocument } from "./documents.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Claw2Config } from "../config/types.js";
import { applyUserConfigPolicy } from "../config/user-config-policy.js";
import { assertPublicUrl } from "../security/url-guard.js";
import { FILES_TOKEN_TTL_MS, filesReadPath, signFilesToken, verifyFilesToken } from "./files-token.js";
import { getConfigPath, loadConfig, loadConfigRaw } from "../config/load.js";
import { resetMemoryStore } from "../memory/index.js";
import { resolveEffectiveTtsEngine, resolveTtsEngine, resolveVoiceSttUrl, resolveVoiceTtsUrl, resolveSttLocal, resolveTtsLocal, resolveSttModel, resolveSttApiKey, resolveTtsModel, resolveTtsApiKey, resolveTtsVoice, fetchTtsVoiceOptions, openaiAudioBase } from "../config/voice.js";
import { composeWebchatUserPayload, formatBrowserSelectionForHistory, type BrowserPageContext } from "../security/content-boundary.js";
import { verifyVisionClaim } from "../security/vision-claim.js";
import { markUntrustedOrigin, hasUntrustedOrigin } from "../security/origin.js";
import { auditLog } from "../audit/log.js";
import { runOrchestrator } from "../core/orchestrator.js";
import { clipHeadTail } from "../core/tool-budget.js";
import {
  foldToolEvents,
  type ToolEvent,
  type ToolTraceEntry,
  type TraceHistoryMessage,
} from "../core/tool-trace.js";
import { isAbortError, throwIfAborted } from "../core/abort.js";
import {
  isBrowserPageTextPending,
  resolveBrowserPageText,
  waitForBrowserPageText,
} from "./browser-page-text-pending.js";
import {
  formatInsightAddendum,
  getInsightOfferWithBudget,
  insightStoreRecordDecision,
  runCheapPass,
  type ClientInsightContext,
  type InsightOffer,
  type InsightReasonCode,
} from "../insights/index.js";
import { assessLlmConfigured, resolveLlmApiKey } from "../config/llm-ready.js";
import { toolSearch, formatSearchHitsMarkdown } from "../tools/search.js";
import {
  cellsToMeta,
  contentForLlmHistory,
  interruptedByFromMeta,
  resolveAssistantCells,
  type InterruptedBy,
} from "../core/cell-blocks.js";
import { deriveChatTitleFromRequest } from "../core/chat-title.js";
import {
  checkForUpdate,
  gatewayVersion as gatewayVersionSafe,
  getUpdateStatus,
  reportUpdateProgress,
  requestUpdate,
  UPDATE_FEED_URL,
} from "./update.js";
import { collectGalleryImages, markImageDeletedInMessages, imageCellsFromUploads, isImagePath } from "./gallery.js";
import {
  collectChatDocuments,
  collectSessionPrefixedDocuments,
  isDocumentPath,
  mergeChatDocuments,
} from "./chat-documents.js";
import { updateRunRating } from "../agent-selection/store.js";
import { getSessionHistory, appendToSession, generateSessionId, getSessionPromptContext, setSessionPromptContext } from "./sessions.js";
import { releaseSessionRuntime } from "./session-runtime-cleanup.js";
import {
  abortChatRun,
  beginChatRun,
  DEFAULT_CHAT_KEEPALIVE_MS,
  DEFAULT_CHAT_RUN_MAX_MS,
  DEFAULT_CHAT_RUN_SETTLE_WAIT_MS,
  DEFAULT_MAX_CONCURRENT_CHAT_RUNS,
  DEFAULT_SHUTDOWN_GRACE_MS,
  finishChatRun,
  getChatRun,
  hasStoredSuccessor,
  isChatShuttingDown,
  markChatRunStored,
  publishChatRun,
  SHUTDOWN_ABORT_REASON,
  startSseKeepalive,
  subscribeChatRun,
  TOOL_STEP_ARGS_CHARS,
  toStepEvent,
  waitForChatRun,
  type ChatRun,
  type ChatRunEvent,
} from "./chat-runs.js";
import { installGracefulShutdown } from "./shutdown.js";
import { applyPromptContext, limitHistoryForPrompt, nextPromptCoveredCount } from "./prompt-history.js";
import { initDb, getChatRepository } from "./db/index.js";
import { createTranscriptSessionAccess, isTranscriptToolsEnabled } from "../transcript/index.js";
import {
  getAuthPool,
  AuthRepository,
  signToken,
  verifyToken,
  getBearerToken,
} from "./auth/index.js";
import { LoginRateLimiter } from "./auth/rate-limit.js";
import { startTelegramBot, sendNotifyToOwner } from "../channels/telegram.js";
import { startVkBot } from "../channels/vk.js";
import { startScheduler } from "../scheduler/runner.js";
import { startLlmBridge } from "../llm-bridge/runner.js";
import { getSipClient, syncSipClient } from "../sip/client.js";
import {
  getRemoteAccessPublicStatus,
  runCertIssue,
  runDdnsUpdate,
  runHttpsClose,
  runHttpsOnTrayHide,
  runHttpsOpen,
  syncRemoteAccess,
} from "../remote-access/service.js";
import { getRemoteHttpsProxySecret, isHttpsListening } from "../remote-access/https-listen.js";
import { collectConnectionsStatus } from "./connections-status.js";
import {
  allCallLogsToMarkdown,
  callLogToMarkdown,
  getCallLog,
  listCallLogRecords,
  listCallLogs,
} from "../sip/call-log.js";
import { handleLlmRoomRoute } from "./llm-room.js";
import {
  listCachesFromDir,
  listQuarantinedCaches,
  exportSessionToClawCacheBuffer,
  importCacheIntoStore,
  acceptQuarantinedCache,
  renameCacheDisplayName,
  deleteCacheFile,
} from "../claw-cache/index.js";
import {
  PiiMasker,
  findPrivacyOcrSidecarBinary,
  resolveMultimodalBackend,
  shouldApplyPrivacy,
} from "../privacy/index.js";
import type { PrivacyCustomRule } from "../privacy/types.js";
import {
  listAgentsWithStatus,
  deleteAgent,
  createAgentStub,
  setAgentEnabledInList,
  normalizeDisabledAgents,
  safeScriptName,
} from "../agents/manage.js";
import {
  readAssistantPersonaForEdit,
  writeAssistantPersonaFile,
  buildAssistantMarkdown,
  parseAssistantMd,
  resetAssistantPersonaCache,
} from "../core/assistant-persona.js";
import {
  resolveAgentsDir,
  resolveAgentsOutputDir,
  resolveAgentsUploadsDir,
  resolveAgentsFilePath,
  resolveAgentsFileSafe,
} from "../agents/paths.js";
import { noFollowFlag, safeRealPath, verifyComponents } from "../security/safe-fs.js";

const DOWNLOAD_ALLOWED_SUBDIRS = ["output", "uploads"];
const SESSION_FILES_OUTPUT_MAX = 100;

const JSON_TYPE = "application/json";
const TEXT_TYPE = "text/plain; charset=utf-8";
const MASK = "***";

function maskSecrets(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(maskSecrets);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "auth" && v && typeof v === "object" && !Array.isArray(v)) {
      const auth = v as Record<string, unknown>;
      out[k] = { ...auth, apiKey: auth.apiKey ? MASK : undefined, sessionSecret: auth.sessionSecret ? MASK : undefined };
    } else if (
      k === "apiKey" ||
      k === "botToken" ||
      k === "sessionSecret" ||
      k === "accessToken" ||
      k === "databaseUrl" ||
      k === "embeddingApiKey" ||
      k === "recognizeSecret" ||
      k === "sdApiKey" ||
      k === "sttApiKey" ||
      k === "ttsApiKey" ||
      k === "token"
    ) {
      out[k] = v ? MASK : undefined;
    } else if (k === "sip" && v && typeof v === "object" && !Array.isArray(v)) {
      const sip = v as Record<string, unknown>;
      const realtime =
        sip.realtime && typeof sip.realtime === "object" && !Array.isArray(sip.realtime)
          ? (() => {
              const rt = sip.realtime as Record<string, unknown>;
              return {
                ...rt,
                apiKey: rt.apiKey ? MASK : undefined,
                iamToken: rt.iamToken ? MASK : undefined,
              };
            })()
          : sip.realtime;
      out[k] = { ...sip, password: sip.password ? MASK : undefined, ...(realtime !== undefined ? { realtime } : {}) };
    } else if (k === "telegram" && v && typeof v === "object" && "botToken" in (v as object)) {
      out[k] = { ...(v as Record<string, unknown>), botToken: (v as Record<string, unknown>).botToken ? MASK : undefined };
    } else if (k === "vk" && v && typeof v === "object" && "accessToken" in (v as object)) {
      out[k] = { ...(v as Record<string, unknown>), accessToken: (v as Record<string, unknown>).accessToken ? MASK : undefined };
    } else {
      out[k] = maskSecrets(v);
    }
  }
  return out;
}

/**
 * Deep merging: base + overrides. Values ​​from overrides overwrite base.
 * Used to obtain an effective config (file as a base, user_config from the database - overrides).
 */
function deepMergeConfig(
  base: Record<string, unknown>,
  overrides: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!overrides || typeof overrides !== "object") return base;
  const result = { ...base };
  for (const key of Object.keys(overrides)) {
    const baseVal = result[key];
    const overrideVal = overrides[key];
    if (
      overrideVal !== undefined &&
      overrideVal !== null &&
      typeof overrideVal === "object" &&
      !Array.isArray(overrideVal) &&
      typeof baseVal === "object" &&
      baseVal !== null &&
      !Array.isArray(baseVal)
    ) {
      (result as Record<string, unknown>)[key] = deepMergeConfig(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>
      );
    } else if (overrideVal !== undefined) {
      (result as Record<string, unknown>)[key] = overrideVal;
    }
  }
  return result;
}

/** Effective config for a request: file (template) + user config from the database.
 * User config passes the security policy filter first (config/user-config-policy.ts):
 * a registered user must not be able to override sandbox/fs/auth/channels policy. */
function getEffectiveConfig(
  fileConfig: Claw2Config,
  userConfig: Record<string, unknown> | null | undefined
): Claw2Config {
  const allowed = applyUserConfigPolicy(userConfig);
  if (!allowed || Object.keys(allowed).length === 0) {
    return fileConfig;
  }
  const merged = deepMergeConfig(
    fileConfig as unknown as Record<string, unknown>,
    allowed
  ) as unknown as Claw2Config;
  applyTenantSecretGuards(merged, allowed as Partial<Claw2Config>);
  return merged;
}

/**
 * Hosted-mode credential isolation: when a tenant points a server-side fetch
 * (LLM provider, STT/TTS) at their own endpoint, the operator's inherited/env
 * key must not ride along — otherwise every request exfiltrates it. The flags
 * set here are deny-only (a tenant can set them, but that only strips keys).
 */
/**
 * Hosted-mode SSRF gate for tenant-overridden server-side endpoints: an LLM
 * baseURL is fetched BY THE GATEWAY on every turn (with the chat context in
 * the body). DNS-aware check (assertPublicUrl) — literal private IPs and
 * hostnames resolving into private ranges are refused.
 * Returns the refusal message, or null when allowed.
 */
async function assertTenantLlmEndpointPublic(
  config: Claw2Config,
  userId: string,
  effective: Claw2Config
): Promise<string | null> {
  if (!isRegistrationMode(config)) return null;
  const repo = getAuthRepo(config);
  if (!repo) return null;
  const userConfig = await getCachedUserConfig(repo, userId);
  const allowed = applyUserConfigPolicy(userConfig);
  const llm = allowed?.llm as { baseURL?: unknown } | undefined;
  const raw = llm?.baseURL;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const normalized = raw.trim().replace(/\/+$/, "");
  const url = /\/v\d+$/.test(normalized) ? normalized : `${normalized}/v1`;
  const guard = await assertPublicUrl(url, false);
  return guard.ok ? null : `llm.baseURL is not allowed: ${guard.error}`;
}

function applyTenantSecretGuards(merged: Claw2Config, overrides: Partial<Claw2Config>): void {
  if (!isRegistrationIntended(merged)) return;
  const llm = overrides.llm as Record<string, unknown> | undefined;
  if (llm && typeof llm.baseURL === "string" && llm.baseURL.trim() && !("apiKey" in llm)) {
    (merged.llm as { noOperatorApiKeyFallback?: boolean }).noOperatorApiKeyFallback = true;
  }
  const voice = overrides.voice as Record<string, unknown> | undefined;
  if (voice) {
    if (typeof voice.sttUrl === "string" && voice.sttUrl.trim() && !("sttApiKey" in voice)) {
      (merged.voice as { sttNoOperatorFallback?: boolean }).sttNoOperatorFallback = true;
    }
    if (typeof voice.ttsUrl === "string" && voice.ttsUrl.trim() && !("ttsApiKey" in voice)) {
      (merged.voice as { ttsNoOperatorFallback?: boolean }).ttsNoOperatorFallback = true;
    }
  }
}

/** User_config cache in memory (TTL 60 s), so as not to go to PostgreSQL for every chat request.*/
const USER_CONFIG_CACHE_TTL_MS = 60_000;
const userConfigCache = new Map<
  string,
  { config: Record<string, unknown> | null; expiresAt: number }
>();

const USER_CONFIG_DB_TIMEOUT_MS = 10_000;

function getCachedUserConfig(
  repo: AuthRepository | null,
  userId: string
): Promise<Record<string, unknown> | null> {
  if (!repo) return Promise.resolve(null);
  const now = Date.now();
  const entry = userConfigCache.get(userId);
  if (entry && entry.expiresAt > now) return Promise.resolve(entry.config);
  const fetchPromise = repo.getUserConfig(userId).then((config) => {
    userConfigCache.set(userId, {
      config,
      expiresAt: now + USER_CONFIG_CACHE_TTL_MS,
    });
    return config;
  });
  const timeoutPromise = new Promise<null>((_, reject) =>
    setTimeout(() => reject(new Error("user_config DB timeout")), USER_CONFIG_DB_TIMEOUT_MS)
  );
  return Promise.race([fetchPromise, timeoutPromise]).catch((err) => {
    console.error(`[gateway] getCachedUserConfig failed (${userId}), using file config:`, err instanceof Error ? err.message : err);
    return null;
  });
}

function invalidateUserConfigCache(userId: string): void {
  userConfigCache.delete(userId);
}

let visionNoSecretWarned = false;
/**
 * One-time notice: a client claimed a vision identity, but no
 * vision.recognizeSecret is configured — the claim cannot be verified and is
 * dropped. Signed claims require the shared secret with the recognition
 * service.
 */
function warnVisionNoSecretOnce(config: Claw2Config): void {
  if (visionNoSecretWarned) return;
  visionNoSecretWarned = true;
  const msg =
    "[vision] recognizedUser received without vision.recognizeSecret — claim rejected. " +
    "Set vision.recognizeSecret (env:VISION_SECRET) and sign claims in the recognition service: " +
    "HMAC-SHA256(`${userId}:${ts}`) → recognizedTs/recognizedSig.";
  if (config.vision?.enabled) console.warn(`[vision] ${msg}`);
  else console.warn(`${msg} (vision is disabled in config — is the client misconfigured?)`);
}

export function mergeConfigKeepingSecrets(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...incoming };
  // memory.chroma only matters for backend "chroma" — but GET /api/config
  // serves it filled with defaults, so every UI save round-trips a zombie
  // section into sqlite/memory configs. Drop it when the backend differs.
  {
    const mem = out.memory as Record<string, unknown> | undefined;
    if (mem && typeof mem === "object" && mem.backend !== "chroma" && "chroma" in mem) {
      const { chroma: _drop, ...rest } = mem;
      out.memory = rest;
    }
  }
  if (existing.gateway && typeof existing.gateway === "object" && out.gateway && typeof out.gateway === "object") {
    const exAuth = (existing.gateway as Record<string, unknown>).auth as Record<string, unknown> | undefined;
    const inAuth = (out.gateway as Record<string, unknown>).auth as Record<string, unknown> | undefined;
    if (exAuth?.apiKey && (inAuth?.apiKey === MASK || inAuth?.apiKey === undefined)) {
      (out.gateway as Record<string, unknown>).auth = { ...inAuth, apiKey: exAuth.apiKey };
    }
    if (exAuth?.sessionSecret && (inAuth?.sessionSecret === MASK || inAuth?.sessionSecret === undefined)) {
      const outAuth = (out.gateway as Record<string, unknown>).auth;
      const base = outAuth && typeof outAuth === "object" ? (outAuth as Record<string, unknown>) : {};
      (out.gateway as Record<string, unknown>).auth = { ...base, sessionSecret: exAuth.sessionSecret };
    }
    // databaseUrl typically embeds the Postgres password — round-trip like a secret.
    const exDbUrl = (existing.gateway as Record<string, unknown>).databaseUrl;
    const inDbUrl = (out.gateway as Record<string, unknown>).databaseUrl;
    if (typeof exDbUrl === "string" && exDbUrl && (inDbUrl === MASK || inDbUrl === undefined)) {
      (out.gateway as Record<string, unknown>).databaseUrl = exDbUrl;
    }
  }
  const exCh = existing.channels as Record<string, unknown> | undefined;
  const inCh = out.channels as Record<string, unknown> | undefined;
  if (exCh?.telegram && inCh?.telegram && typeof exCh === "object" && typeof inCh === "object") {
    const exT = exCh.telegram as Record<string, unknown> | undefined;
    const inT = inCh.telegram as Record<string, unknown> | undefined;
    if (exT?.botToken && (inT?.botToken === MASK || inT?.botToken === undefined)) {
      (inCh as Record<string, unknown>).telegram = { ...inT, botToken: exT.botToken };
    }
  }
  if (exCh?.vk && inCh?.vk && typeof exCh === "object" && typeof inCh === "object") {
    const exV = exCh.vk as Record<string, unknown> | undefined;
    const inV = inCh.vk as Record<string, unknown> | undefined;
    if (exV?.accessToken && (inV?.accessToken === MASK || inV?.accessToken === undefined)) {
      (inCh as Record<string, unknown>).vk = { ...inV, accessToken: exV.accessToken };
    }
  }
  if (existing.llm && typeof existing.llm === "object" && out.llm && typeof out.llm === "object") {
    const exApiKey = (existing.llm as Record<string, unknown>).apiKey;
    const inApiKey = (out.llm as Record<string, unknown>).apiKey;
    if (exApiKey && (inApiKey === MASK || inApiKey === undefined)) {
      (out.llm as Record<string, unknown>).apiKey = exApiKey;
    }
  }
  const exCoding = (existing.agentSelection as Record<string, unknown> | undefined)?.codingModel as Record<string, unknown> | undefined;
  const outCoding = (out.agentSelection as Record<string, unknown> | undefined)?.codingModel as Record<string, unknown> | undefined;
  if (exCoding && outCoding && typeof exCoding === "object" && typeof outCoding === "object") {
    const exKey = exCoding.apiKey;
    const inKey = outCoding.apiKey;
    if (exKey && (inKey === MASK || inKey === undefined)) {
      (out.agentSelection as Record<string, unknown>).codingModel = { ...outCoding, apiKey: exKey };
    }
  }
  if (existing.memory && typeof existing.memory === "object" && out.memory && typeof out.memory === "object") {
    const exMem = existing.memory as Record<string, unknown>;
    const inMem = out.memory as Record<string, unknown>;
    if (exMem.embeddingApiKey && (inMem.embeddingApiKey === MASK || inMem.embeddingApiKey === undefined)) {
      (out.memory as Record<string, unknown>).embeddingApiKey = exMem.embeddingApiKey;
    }
  }
  if (existing.tools && typeof existing.tools === "object" && out.tools && typeof out.tools === "object") {
    const exTools = existing.tools as Record<string, unknown>;
    const inTools = out.tools as Record<string, unknown>;
    if (exTools.sdApiKey && (inTools.sdApiKey === MASK || inTools.sdApiKey === undefined)) {
      (out.tools as Record<string, unknown>).sdApiKey = exTools.sdApiKey;
    }
    const exTavily = exTools.tavily as Record<string, unknown> | undefined;
    const inTavily = inTools.tavily as Record<string, unknown> | undefined;
    if (exTavily?.apiKey && inTavily && (inTavily.apiKey === MASK || inTavily.apiKey === undefined)) {
      (out.tools as Record<string, unknown>).tavily = { ...inTavily, apiKey: exTavily.apiKey };
    }
    const exSearx = exTools.searxng as Record<string, unknown> | undefined;
    const inSearx = inTools.searxng as Record<string, unknown> | undefined;
    if (exSearx?.apiKey && inSearx && (inSearx.apiKey === MASK || inSearx.apiKey === undefined)) {
      (out.tools as Record<string, unknown>).searxng = { ...inSearx, apiKey: exSearx.apiKey };
    }
    const exOther = exTools.other as Record<string, unknown> | undefined;
    const inOther = inTools.other as Record<string, unknown> | undefined;
    if (exOther?.apiKey && inOther && (inOther.apiKey === MASK || inOther.apiKey === undefined)) {
      (out.tools as Record<string, unknown>).other = { ...inOther, apiKey: exOther.apiKey };
    }
  }
  if (existing.voice && typeof existing.voice === "object" && out.voice && typeof out.voice === "object") {
    const exVoice = existing.voice as Record<string, unknown>;
    const inVoice = out.voice as Record<string, unknown>;
    if (exVoice.sttApiKey && (inVoice.sttApiKey === MASK || inVoice.sttApiKey === undefined)) {
      (out.voice as Record<string, unknown>).sttApiKey = exVoice.sttApiKey;
    }
    if (exVoice.ttsApiKey && (inVoice.ttsApiKey === MASK || inVoice.ttsApiKey === undefined)) {
      (out.voice as Record<string, unknown>).ttsApiKey = exVoice.ttsApiKey;
    }
  }
  if (existing.sip && typeof existing.sip === "object" && out.sip && typeof out.sip === "object") {
    const exSip = existing.sip as Record<string, unknown>;
    const inSip = out.sip as Record<string, unknown>;
    if (exSip.password && (inSip.password === MASK || inSip.password === undefined)) {
      (out.sip as Record<string, unknown>).password = exSip.password;
    }
    const exRt = exSip.realtime as Record<string, unknown> | undefined;
    const inRt = inSip.realtime as Record<string, unknown> | undefined;
    if (exRt && typeof exRt === "object" && inRt && typeof inRt === "object") {
      const nextRt = { ...inRt };
      if (exRt.apiKey && (inRt.apiKey === MASK || inRt.apiKey === undefined)) {
        nextRt.apiKey = exRt.apiKey;
      }
      if (exRt.iamToken && (inRt.iamToken === MASK || inRt.iamToken === undefined)) {
        nextRt.iamToken = exRt.iamToken;
      }
      (out.sip as Record<string, unknown>).realtime = nextRt;
    }
  }
  if (existing.remoteAccess && typeof existing.remoteAccess === "object" && out.remoteAccess && typeof out.remoteAccess === "object") {
    const exRa = existing.remoteAccess as Record<string, unknown>;
    const inRa = out.remoteAccess as Record<string, unknown>;
    if (exRa.accessToken && (inRa.accessToken === MASK || inRa.accessToken === undefined)) {
      inRa.accessToken = exRa.accessToken;
    }
    const exDdns = exRa.ddns as Record<string, unknown> | undefined;
    const inDdns = inRa.ddns as Record<string, unknown> | undefined;
    if (exDdns && inDdns && typeof exDdns === "object" && typeof inDdns === "object") {
      if (exDdns.token && (inDdns.token === MASK || inDdns.token === undefined)) {
        (out.remoteAccess as Record<string, unknown>).ddns = { ...inDdns, token: exDdns.token };
      }
    }
  }
  if (existing.llmBridge && typeof existing.llmBridge === "object" && out.llmBridge && typeof out.llmBridge === "object") {
    const exBridge = existing.llmBridge as Record<string, unknown>;
    const inBridge = out.llmBridge as Record<string, unknown>;
    if (exBridge.token && (inBridge.token === MASK || inBridge.token === undefined)) {
      (out.llmBridge as Record<string, unknown>).token = exBridge.token;
    }
  }
  return out;
}

/**
 * Request-body caps: an oversized upload must be dropped mid-stream, not
 * buffered whole into memory. /chat is allowed the most (attachments travel
 * base64-encoded in JSON); voice STT gets an audio-sized cap; everything
 * else — a small default.
 */
const DEFAULT_BODY_LIMIT_BYTES = 16 * 1024 * 1024;
// Chat bodies carry base64 attachments; the composer caps 10 files x 15 MB
// (~150 MB raw → ~200 MB base64). 224 MiB leaves headroom while cutting the
// concurrent-allocation surface more than twofold vs the previous 512 MiB.
const CHAT_BODY_LIMIT_BYTES = 224 * 1024 * 1024;
const STT_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

function parseRawBody(req: IncomingMessage, maxBytes = DEFAULT_BODY_LIMIT_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseBody(req: IncomingMessage, maxBytes = DEFAULT_BODY_LIMIT_BYTES): Promise<string> {
  return parseRawBody(req, maxBytes).then((b) => b.toString("utf-8"));
}

function checkAuth(config: Claw2Config, req: IncomingMessage): boolean {
  const auth = config.gateway?.auth;
  // Fail closed: enabled auth without a key must never open the gateway.
  if (!auth?.enabled) return true;
  const apiKey = auth.apiKey?.trim();
  if (!apiKey) return false;
  const key = req.headers["x-api-key"] ?? req.headers["authorization"]?.toString().replace(/^Bearer\s+/i, "");
  return typeof key === "string" && safeTokenEqual(key.trim(), apiKey);
}

function isRemoteHttpsRequest(req: IncomingMessage): boolean {
  return String(req.headers["x-claw2-via"] ?? "").toLowerCase() === "remote-https";
}

function resolveCompanionAccessToken(config: Claw2Config): string | undefined {
  const t = config.remoteAccess?.accessToken?.trim();
  if (!t || t === MASK) return undefined;
  return t;
}

function extractAccessCredential(req: IncomingMessage): string {
  const bearer = getBearerToken(req);
  if (bearer) return bearer.trim();
  const x =
    req.headers["x-access-token"] ??
    req.headers["x-api-key"];
  if (typeof x === "string") return x.trim();
  if (Array.isArray(x) && typeof x[0] === "string") return x[0].trim();
  return "";
}

function safeTokenEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length || ba.length === 0) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/** True when `file` resolves strictly inside `root` (path-separator aware). */
function isInsideRoot(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function isCompanionPublicPath(path: string): boolean {
  if (path === "/api/companion/auth") return true;
  if (path === "/pwa" || path.startsWith("/pwa/")) return true;
  return false;
}

/**
 * Remote HTTPS (DuckDNS) must present remoteAccess.accessToken.
 * Local Electron → gateway has no X-Claw2-Via and stays open.
 * The via-header alone is not trusted: it must be paired with this process's
 * proxy secret (getRemoteHttpsProxySecret) — a header only the in-process
 * TLS proxy can produce. Requests that reach the plain listener directly
 * cannot forge it; spoofing the via-header through any other channel is
 * rejected outright.
 */
function checkCompanionAccess(config: Claw2Config, req: IncomingMessage, path: string): {
  ok: boolean;
  code?: string;
  error?: string;
} {
  if (!isRemoteHttpsRequest(req)) return { ok: true };
  const secretHeader = req.headers["x-claw2-proxy-secret"];
  const secretProvided = typeof secretHeader === "string" ? secretHeader.trim() : "";
  const secretExpected = getRemoteHttpsProxySecret();
  if (!secretProvided || !safeTokenEqual(secretProvided, secretExpected)) {
    return {
      ok: false,
      code: "companion_proxy_untrusted",
      error: "Unauthorized",
    };
  }
  if (isCompanionPublicPath(path)) return { ok: true };
  const expected = resolveCompanionAccessToken(config);
  if (!expected) {
    return {
      ok: false,
      code: "companion_token_missing",
      error: "Remote HTTPS requires remoteAccess.accessToken in settings",
    };
  }
  const provided = extractAccessCredential(req);
  if (!provided || !safeTokenEqual(provided, expected)) {
    return {
      ok: false,
      code: "companion_token_required",
      error: "Unauthorized",
    };
  }
  return { ok: true };
}

function pathname(req: IncomingMessage): string {
  return (req.url ?? "").split("?")[0];
}

/** Content-Disposition with ASCII only (Node rejects Cyrillic in titles).*/
function contentDispositionAttachment(filename: string): string {
  const trimmed = filename.replace(/[\r\n"]/g, "_").trim() || "export.claw-cache";
  const asciiFallback =
    trimmed.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_").replace(/_+/g, "_") || "export.claw-cache";
  if (asciiFallback === trimmed) {
    return `attachment; filename="${asciiFallback}"`;
  }
  const encoded = encodeURIComponent(trimmed).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

let authRepoInstance: AuthRepository | null = null;

/**
 * Brute-force guard for /api/login and /api/register: 10 failures in 5 minutes
 * (per ip:login) lock the key out for 15 minutes. Swept periodically to bound
 * memory. In-memory only — restarting the gateway clears the state.
 */
const authRateLimiter = new LoginRateLimiter({ maxFailures: 10 });
const authRateSweepTimer = setInterval(() => authRateLimiter.sweep(), 5 * 60_000);
if (typeof authRateSweepTimer.unref === "function") authRateSweepTimer.unref();

function authRateKey(req: IncomingMessage, login: string): string {
  const ip = req.socket.remoteAddress ?? "unknown";
  return `${ip}:${login.toLowerCase()}`;
}

function getAuthRepo(config: Claw2Config): AuthRepository | null {
  const url = config.gateway?.databaseUrl?.trim();
  if (!url) return null;
  if (authRepoInstance) return authRepoInstance;
  authRepoInstance = new AuthRepository(getAuthPool(url));
  return authRepoInstance;
}

function isRegistrationMode(config: Claw2Config): boolean {
  // Individual desktop client: without multi-user JWT (hosted mode is not touched).
  if (process.env.CLAW2_DESKTOP === "1") return false;
  return !!(
    config.gateway?.auth?.registrationEnabled &&
    config.gateway?.databaseUrl?.trim() &&
    config.gateway?.auth?.sessionSecret &&
    config.gateway.auth.sessionSecret.length >= 32
  );
}

/**
 * True when an operator INTENDS hosted mode (registrationEnabled + databaseUrl)
 * but the setup is incomplete (sessionSecret missing/short) — isRegistrationMode
 * returns false then and the JWT gate would silently disappear. The pipeline
 * fails closed on this half-configured state instead (registrationGateActive).
 */
function isRegistrationIntended(config: Claw2Config): boolean {
  if (process.env.CLAW2_DESKTOP === "1") return false;
  return !!(
    config.gateway?.auth?.registrationEnabled &&
    config.gateway?.databaseUrl?.trim()
  );
}

/** Operator logins allowed to approve skills / restart / drive remote access. Empty list = nobody. */
function isRegistrationAdmin(config: Claw2Config, userLogin: string): boolean {
  const admins = (config.gateway?.auth?.admins ?? [])
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  return !!userLogin && admins.includes(userLogin.trim().toLowerCase());
}

/**
 * Auth endpoints stay public for any method (register/login/logout are POST).
 * UI-shell pages are public only for GET/HEAD: the page HTML must load before
 * the browser can ask for credentials, but a state-changing request to those
 * paths (POST /chat!) must always present a verified identity — otherwise a
 * path-based exception would open the chat-processing route itself to
 * unauthenticated callers.
 */
const AUTH_PUBLIC_DATA_PATHS = new Set([
  "/api/register",
  "/api/login",
  "/api/logout",
  "/api/me", // session check without token → 401 JSON
  "/api/voice/capabilities",
  "/health",
]);

const AUTH_PUBLIC_PAGE_PATHS = new Set([
  "/",
  "/chat",
  "/login",
  "/register",
  "/cabinet",
  "/cabinet/settings",
  "/cabinet/account",
  "/cabinet/skills",
  "/cabinet/persona",
  "/cabinet/activation-cache",
  "/gallery",
  "/documents",
  "/calls",
]);

/**
 * Trusted Host-header check for the auth-off cross-site guard: IP literals,
 * localhost and mDNS .local names are always accepted; anything else must be
 * listed in gateway.trustedHosts. (With auth on, the key gates everything and
 * this check does not run.)
 */
function isTrustedHostHeader(hostHeader: unknown, config: Claw2Config): boolean {
  if (typeof hostHeader !== "string" || !hostHeader.trim()) return false;
  const hostname = hostHeader
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/^\[/, "")
    .replace(/\]$/, "");
  if (!hostname) return false;
  if (isIP(hostname) >= 4) return true;
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return true;
  const trusted = (config.gateway?.trustedHosts ?? [])
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return trusted.includes(hostname);
}

function isAuthPublicPath(method: string, path: string): boolean {
  const reading = method === "GET" || method === "HEAD";
  if (AUTH_PUBLIC_DATA_PATHS.has(path)) return true;
  // UI pages and static assets: public only for reads. /files/ is deliberately
  // NOT public: uploads and outputs are private user data.
  if (reading && AUTH_PUBLIC_PAGE_PATHS.has(path)) return true;
  if (reading && (path.startsWith("/assets/") || path.startsWith("/pwa"))) return true;
  // Built-in wiki shell + pages: documentation content, not user data.
  if (reading && (path === "/wiki" || path.startsWith("/wiki/"))) return true;
  // Static files (pictures, favicon) - without authorization, so that the login form loads
  if (reading && /^\/[^/]*\.(jpg|jpeg|png|gif|svg|ico|webp|woff2?)$/i.test(path)) return true;
  return false;
}

/**
 * Paths that stay GET-public when gateway.auth (single API key) is on: the
 * health probe and the UI shell — SPA pages and static assets. The browser
 * cannot ask the user for the API key until the interface HTML/JS has loaded;
 * the UI then attaches the key to every data request. Data routes (/api/*,
 * /chat/*, /files/*, /project/*) always require the key.
 */
function isUiShellPath(path: string): boolean {
  if (path === "/health") return true;
  // Built-in wiki shell and its markdown pages: documentation content.
  if (path === "/wiki" || path.startsWith("/wiki/")) return true;
  if (
    path === "/" ||
    path === "/index.html" ||
    path === "/chat" ||
    path === "/login" ||
    path === "/register" ||
    path === "/cabinet" ||
    path === "/gallery" ||
    path === "/documents" ||
    path === "/calls" ||
    path.startsWith("/cabinet/") ||
    path.startsWith("/gallery/") ||
    path.startsWith("/documents/") ||
    path.startsWith("/calls/")
  ) {
    return true;
  }
  if (path.startsWith("/assets/") || path.startsWith("/pwa")) return true;
  if (/^\/[^/]*\.(jpg|jpeg|png|gif|svg|ico|webp|woff2?)$/i.test(path)) return true;
  return false;
}

/** Cached account state for token verification (TTL 60 s — one DB hit per minute per user). */
const USER_AUTH_STATE_TTL_MS = 60_000;
const userAuthStateCache = new Map<
  string,
  { status: string; tokenVersion: number; expiresAt: number }
>();

function invalidateUserAuthState(userId: string): void {
  userAuthStateCache.delete(userId);
}

/**
 * JWT verification + live account state: the token must belong to an ACTIVE
 * account and carry the token version at issue time (password change bumps
 * it and invalidates outstanding tokens). Returns null for any mismatch.
 */
async function verifyAuthIdentity(
  config: Claw2Config,
  req: IncomingMessage
): Promise<{ userId: string; login: string } | null> {
  const token = getBearerToken(req);
  if (!token) return null;
  const secret = config.gateway?.auth?.sessionSecret;
  if (!secret) return null;
  const payload = verifyToken(token, secret);
  if (!payload) return null;
  const repo = getAuthRepo(config);
  if (!repo) return null;
  const now = Date.now();
  const cached = userAuthStateCache.get(payload.userId);
  let state: { status: string; tokenVersion: number } | null;
  if (cached && cached.expiresAt > now) {
    state = { status: cached.status, tokenVersion: cached.tokenVersion };
  } else {
    state = await repo.getAuthState(payload.userId);
    if (state) {
      userAuthStateCache.set(payload.userId, { ...state, expiresAt: now + USER_AUTH_STATE_TTL_MS });
    } else {
      userAuthStateCache.delete(payload.userId);
    }
  }
  if (!state) return null;
  if (state.status !== "active") return null;
  if ((payload.ver ?? 0) !== state.tokenVersion) return null;
  return { userId: payload.userId, login: payload.login };
}

function getChatPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>claw2 Chat</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem; }
    #log { border: 1px solid #ccc; border-radius: 8px; min-height: 200px; padding: 0.75rem; margin-bottom: 1rem; background: #fafafa; }
    .msg { margin: 0.5rem 0; }
    .msg.user { color: #06c; }
    .msg.assistant { color: #363; }
    input[type="text"] { width: 100%; padding: 0.5rem; box-sizing: border-box; }
    button { margin-top: 0.5rem; padding: 0.5rem 1rem; cursor: pointer; }
  </style>
</head>
<body>
  <h1>claw2 Chat</h1>
  <div id="log"></div>
  <form id="form">
    <input type="text" id="input" placeholder="Message..." autocomplete="off">
    <button type="submit">Submit</button>
  </form>
  <script>
    let sessionId = sessionStorage.getItem('claw2_session') || '';
    const log = document.getElementById('log');
    const form = document.getElementById('form');
    const input = document.getElementById('input');
    function addMsg(role, text) {
      const d = document.createElement('div');
      d.className = 'msg ' + role;
      d.textContent = (role === 'user' ? 'You: ' : 'Agent: ') + text;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
    }
    form.onsubmit = async(e) => {
      e.preventDefault();
      const message = input.value.trim();
      if (!message) return;
      addMsg('user', message);
      input.value = '';
      try {
        const res = await fetch('/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, sessionId: sessionId || undefined })
        });
        const data = await res.json();
        if (data.sessionId) { sessionId = data.sessionId; sessionStorage.setItem('claw2_session', sessionId); }
        if (data.error) addMsg('assistant', 'Error: ' + data.error);
        else addMsg('assistant', data.content);
      } catch (err) {
        addMsg('assistant', 'Error: ' + err.message);
      }
    };
  </script>
</body>
</html>`;
}

export function createGatewayServer(configRef: { current: Claw2Config }) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const config = configRef.current;
    const agentsDir = resolveAgentsDir(config);
    const outputDir = resolveAgentsOutputDir(config);
    const uploadsDir = resolveAgentsUploadsDir(config);
    const p = pathname(req);
    /**
     * Effective auth: enabled AND a key present (fail-closed in checkAuth).
     * Drives both CORS grants and the cross-site host guard below.
     */
    const authEffective = !!(
      config.gateway?.auth?.enabled &&
      config.gateway?.auth?.apiKey?.trim()
    );
    /** Desktop: echo only localhost / file / app origins; hosted keeps *. */
    const corsOrigin = resolveCorsAllowOrigin(req, authEffective);
    /**
     * Auth-off guard against cross-site requests and DNS rebinding: a browser
     * sent here by a malicious page carries that page's host (or a rebound
     * domain) in the Host header. Real deployments use IPs, localhost, *.local
     * or hosts listed in gateway.trustedHosts.
     */
    if (!authEffective && req.headers.host !== undefined && !isTrustedHostHeader(req.headers.host, config)) {
      res.writeHead(403, { "Content-Type": TEXT_TYPE, "Access-Control-Allow-Origin": corsOrigin });
      res.end(
        "Forbidden: host not trusted. Enable gateway.auth or add this hostname to gateway.trustedHosts."
      );
      return;
    }
    /**
     * CSRF guard for auth-off deployments. The Host check above stops DNS
     * rebinding but not plain cross-site POSTs: CORS cannot prevent a simple
     * request from being SENT (a text/plain body with a JSON payload reaches
     * the JSON parser untouched). Browsers always mark such requests with
     * Origin / Sec-Fetch-Site — reject state-changing requests carrying
     * cross-site indicators. Non-browser clients (curl, native) send no
     * markers and are unaffected; same-origin UI matches its own Host.
     */
    if (!authEffective && req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
      const origin = req.headers.origin;
      if (typeof origin === "string" && origin.trim()) {
        let sameOrigin = false;
        try {
          const u = new URL(origin);
          sameOrigin = !!req.headers.host && u.host === req.headers.host;
        } catch {
          /* malformed Origin — treat as cross-site */
        }
        if (!sameOrigin) {
          res.writeHead(403, { "Content-Type": TEXT_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end("Forbidden: cross-site request");
          return;
        }
      }
      const fetchSite = req.headers["sec-fetch-site"];
      if (typeof fetchSite === "string" && fetchSite.trim().toLowerCase() === "cross-site") {
        res.writeHead(403, { "Content-Type": TEXT_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end("Forbidden: cross-site request");
        return;
      }
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": corsOrigin,
        "Access-Control-Allow-Methods": "POST, GET, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-API-Key, Authorization, X-Session-Id, X-Access-Token",
        Vary: "Origin",
      });
      res.end();
      return;
    }
    const companion = checkCompanionAccess(config, req, p);
    if (!companion.ok) {
      res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
      res.end(
        JSON.stringify({
          error: companion.error || "Unauthorized",
          code: companion.code || "companion_token_required",
        })
      );
      return;
    }
    if (req.method === "GET" && p === "/api/companion/auth") {
      const remote = isRemoteHttpsRequest(req);
      const expected = resolveCompanionAccessToken(config);
      if (!remote) {
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ required: false, ok: true, remote: false }));
        return;
      }
      if (!expected) {
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(
          JSON.stringify({
            required: true,
            ok: false,
            remote: true,
            code: "companion_token_missing",
            error: "Set remoteAccess.accessToken in desktop settings",
          })
        );
        return;
      }
      const provided = extractAccessCredential(req);
      const ok = !!(provided && safeTokenEqual(provided, expected));
      res.writeHead(ok ? 200 : 401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
      res.end(
        JSON.stringify(
          ok
            ? { required: true, ok: true, remote: true }
            : {
                required: true,
                ok: false,
                remote: true,
                code: "companion_token_required",
                error: provided ? "Invalid token" : "Token required",
              }
        )
      );
      return;
    }
    const hostedRequested = config.gateway?.auth?.registrationEnabled === true;
    const personalFileSecret = authEffective && !hostedRequested
      ? config.gateway?.auth?.apiKey?.trim() : undefined;
    const keyAuthorized = checkAuth(config, req);
    const filePath = req.method === "GET" ? filesReadPath(p) : null;
    const fileGrant = personalFileSecret && filePath
      ? verifyFilesToken(personalFileSecret, new URLSearchParams(req.url?.split("?", 2)[1]).get("k") ?? "", filePath)
      : null;
    if (!keyAuthorized && !(req.method === "GET" && isUiShellPath(p)) && fileGrant?.userId !== "default") {
      res.writeHead(401, { "Content-Type": TEXT_TYPE, "Access-Control-Allow-Origin": corsOrigin });
      res.end("Unauthorized");
      return;
    }

    // --- Auth API (registration mode) ---
    if (req.method === "POST" && p === "/api/register") {
      const repo = getAuthRepo(config);
      const secret = config.gateway?.auth?.sessionSecret;
      if (!repo || !secret || !isRegistrationMode(config)) {
        res.writeHead(503, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Registration not configured (gateway.databaseUrl and auth.registrationEnabled, sessionSecret)" }));
        return;
      }
      try {
        const body = await parseBody(req);
        const data = (body ? JSON.parse(body) : {}) as { login?: string; email?: string; password?: string };
        const login = typeof data.login === "string" ? data.login.trim() : "";
        const email = typeof data.email === "string" ? data.email.trim() || null : null;
        const password = typeof data.password === "string" ? data.password : "";
        const regKey = authRateKey(req, login || "anonymous");
        const regCheck = authRateLimiter.attempt(regKey);
        if (!regCheck.allowed) {
          res.writeHead(429, {
            "Content-Type": JSON_TYPE,
            "Access-Control-Allow-Origin": corsOrigin,
            "Retry-After": String(regCheck.retryAfterSec ?? 60),
          });
          res.end(JSON.stringify({ error: "Too many attempts; try again later" }));
          return;
        }
        if (!login || !password) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "login and password required" }));
          return;
        }
        if (password.length < 6) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "password must be at least 6 characters" }));
          return;
        }
        await repo.ensureSchema();
        if (await repo.checkLoginExists(login)) {
          authRateLimiter.failure(regKey);
          res.writeHead(409, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "login already taken" }));
          return;
        }
        if (email && (await repo.checkEmailExists(email))) {
          authRateLimiter.failure(regKey);
          res.writeHead(409, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "email already taken" }));
          return;
        }
        const user = await repo.createUser({ login, email, password });
        authRateLimiter.success(regKey);
        const token = signToken({ userId: user.id, login: user.login, ver: user.token_version }, secret);
        res.writeHead(201, {
          "Content-Type": JSON_TYPE,
          "Access-Control-Allow-Origin": corsOrigin,
          "Access-Control-Expose-Headers": "Authorization",
          Authorization: `Bearer ${token}`,
        });
        res.end(JSON.stringify({ ok: true, user: repo.toPublic(user), token }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const cause = err instanceof Error && err.cause instanceof Error ? (err.cause as Error).message : "";
        const fullMsg = cause ? `${msg}: ${cause}` : msg;
        console.error("[gateway] register failed:", fullMsg, err);
        if (!res.headersSent) {
          // Generic client text: raw DB errors leak infrastructure details.
          res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({
            error: "Registration is temporarily unavailable",
            hint: /ECONNREFUSED|connect|ENOTFOUND|timeout|getaddrinfo/i.test(fullMsg)
              ? "Check the gateway.databaseUrl in .claw2/claw2.yaml on the server: the host should be postgres:5432 (not localhost). And that the postgres container is running (docker compose ps)."
              : undefined,
          }));
        }
      }
      return;
    }

    if (req.method === "POST" && p === "/api/login") {
      const repo = getAuthRepo(config);
      const secret = config.gateway?.auth?.sessionSecret;
      if (!repo || !secret || !isRegistrationMode(config)) {
        res.writeHead(503, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Login not configured" }));
        return;
      }
      try {
        const body = await parseBody(req);
        const data = (body ? JSON.parse(body) : {}) as { login?: string; password?: string };
        const login = typeof data.login === "string" ? data.login.trim() : "";
        const password = typeof data.password === "string" ? data.password : "";
        if (!login || !password) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "login and password required" }));
          return;
        }
        const rateKey = authRateKey(req, login || "anonymous");
        const rateCheck = authRateLimiter.attempt(rateKey);
        if (!rateCheck.allowed) {
          res.writeHead(429, {
            "Content-Type": JSON_TYPE,
            "Access-Control-Allow-Origin": corsOrigin,
            "Retry-After": String(rateCheck.retryAfterSec ?? 60),
          });
          res.end(JSON.stringify({ error: "Too many attempts; try again later" }));
          return;
        }
        const user = await repo.findByLogin(login);
        if (!user || !(await repo.verifyPassword(user, password))) {
          // Uniform error for unknown login, bad password AND locked accounts —
          // no account-status oracle for credential stuffing.
          authRateLimiter.failure(rateKey);
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Invalid login or password" }));
          return;
        }
        if (user.status !== "active") {
          authRateLimiter.failure(rateKey);
          res.writeHead(403, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Account is not active", code: `account_${user.status}` }));
          return;
        }
        authRateLimiter.success(rateKey);
        const token = signToken({ userId: user.id, login: user.login, ver: user.token_version }, secret);
        res.writeHead(200, {
          "Content-Type": JSON_TYPE,
          "Access-Control-Allow-Origin": corsOrigin,
          "Access-Control-Expose-Headers": "Authorization",
          Authorization: `Bearer ${token}`,
        });
        res.end(JSON.stringify({ ok: true, user: repo.toPublic(user), token }));
      } catch (err) {
        console.error("[gateway] login failed:", err);
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "POST" && p === "/api/logout") {
      res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "GET" && p === "/api/me") {
      if (!isRegistrationMode(config)) {
        res.writeHead(404, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Not Found" }));
        return;
      }
      const payload = await verifyAuthIdentity(config, req);
      if (!payload) {
        res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
        return;
      }
      const repo = getAuthRepo(config);
      if (!repo) {
        res.writeHead(503, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Auth not configured" }));
        return;
      }
      try {
        const user = await repo.findById(payload.userId);
        if (!user) {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "User not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify(repo.toPublic(user)));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "PUT" && p === "/api/me/password") {
      const payload = await verifyAuthIdentity(config, req);
      if (!payload || !isRegistrationMode(config)) {
        res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      const repo = getAuthRepo(config);
      if (!repo) {
        res.writeHead(503, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Auth not configured" }));
        return;
      }
      try {
        const body = await parseBody(req);
        const data = (body ? JSON.parse(body) : {}) as { currentPassword?: string; newPassword?: string };
        const current = typeof data.currentPassword === "string" ? data.currentPassword : "";
        const newPwd = typeof data.newPassword === "string" ? data.newPassword : "";
        if (!current || !newPwd || newPwd.length < 6) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "currentPassword and newPassword (min 6 chars) required" }));
          return;
        }
        const user = await repo.findById(payload.userId);
        const pwdKey = `pwd:${payload.userId}`;
        const pwdCheck = authRateLimiter.attempt(pwdKey);
        if (!pwdCheck.allowed) {
          res.writeHead(429, {
            "Content-Type": JSON_TYPE,
            "Access-Control-Allow-Origin": corsOrigin,
            "Retry-After": String(pwdCheck.retryAfterSec ?? 60),
          });
          res.end(JSON.stringify({ error: "Too many attempts; try again later" }));
          return;
        }
        if (!user || !(await repo.verifyPassword(user, current))) {
          authRateLimiter.failure(pwdKey);
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Invalid current password" }));
          return;
        }
        authRateLimiter.success(pwdKey);
        await repo.updatePassword(payload.userId, newPwd);
        invalidateUserAuthState(payload.userId);
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // --- Require JWT for protected paths when registration mode ---
    let userId: string = "default";
    let userLogin = "";
    // Fail closed: an operator who set registrationEnabled + databaseUrl but
    // botched the sessionSecret must not silently get an open gateway
    // (isRegistrationMode would return false and the JWT gate vanish).
    const registrationGateActive = isRegistrationMode(config) || isRegistrationIntended(config);
    if (registrationGateActive) {
      const authPayload = await verifyAuthIdentity(config, req);
      if (!isAuthPublicPath(req.method ?? "GET", p) && !authPayload) {
        res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
        return;
      }
      if (authPayload) {
        userId = authPayload.userId;
        userLogin = authPayload.login;
      }
    }
    // Identity comes only from a verified JWT (registration mode). The legacy
    // X-User-Id header fallback is gone: any caller could otherwise read and
    // rewrite another user namespace in the shared chats DB. The UIs send
    // "default", which is the single-owner namespace anyway.
    // Desktop single-user: PWA + Electron share one chat namespace in SQLite.
    // Auth/JWT still gates access; only the chats.user_id key is unified.
    if (process.env.CLAW2_DESKTOP?.trim() === "1") {
      userId = "default";
    }

    if (await handleLlmRoomRoute(config, req, res, p, userId, userLogin)) {
      return;
    }

    // --- Self-update: latest-release check + host-updater coordination ---
    if (req.method === "GET" && p === "/api/update/check") {
      if (config.updates?.check === false) {
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ current: gatewayVersionSafe(), checksDisabled: true }));
        return;
      }
      try {
        const result = await checkForUpdate(config.updates?.feedUrl?.trim() || UPDATE_FEED_URL);
        const status = getUpdateStatus();
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin, "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ...result, autoUpdate: status.autoUpdate }));
      } catch (err) {
        res.writeHead(502, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (req.method === "GET" && p === "/api/update/status") {
      const status = getUpdateStatus();
      res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin, "Cache-Control": "no-store" });
      res.end(JSON.stringify(status));
      return;
    }
    if (req.method === "POST" && p === "/api/update/request") {
      requestUpdate();
      res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && p === "/api/update/report") {
      // The host-side updater (scripts/update.sh) reports progress; it runs on
      // the operator's machine and authenticates with the gateway key.
      try {
        const body = await parseBody(req, 16 * 1024);
        const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const next = reportUpdateProgress(data);
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ ok: true, percent: next.percent, step: next.step }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (req.method === "GET" && p === "/api/files-token") {
      const requestUrl = new URL(req.url ?? "", "http://localhost");
      const path = filesReadPath(requestUrl.searchParams.get("path") ?? "");
      const secret = personalFileSecret ?? (registrationGateActive
        ? config.gateway?.auth?.sessionSecret?.trim() : undefined);
      if (!secret || !path) {
        res.writeHead(!secret ? 403 : 400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: !secret ? "File tokens unavailable" : "Invalid file path" }));
        return;
      }
      const exp = Date.now() + FILES_TOKEN_TTL_MS;
      res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin, "Cache-Control": "no-store" });
      res.end(JSON.stringify({ k: signFilesToken(secret, userId, exp, path), exp }));
      return;
    }
    if (req.method === "POST" && p === "/chat") {
      let activeRun: ChatRun | undefined;
      /** True once the response is driven by the run's events, not by this handler. */
      let handedOff = false;
      let onRequestAborted: (() => void) | undefined;
      let onResponseClose: (() => void) | undefined;
      let activeSessionId = "";
      let streamSessionId: string | undefined;
      let auditConfig = config;
      const requestStartMs = Date.now();
      const openChatStream = (sessionId: string) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          // A reverse proxy must not buffer a stream that is silent while a tool runs.
          "X-Accel-Buffering": "no",
          "Access-Control-Allow-Origin": corsOrigin,
          "X-Session-Id": sessionId,
        });
        // A client that vanishes mid-stream must not take the gateway down with a socket error.
        res.on("error", () => {
          /* the client went away */
        });
        // writeHead alone keeps the headers until the first frame; a turn can
        // be silent for a long time (model thinking, a running tool).
        res.flushHeaders();
        streamSessionId = sessionId;
      };
      const formatChatEvent = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
      const writeChatEvent = (payload: Record<string, unknown>) => {
        if (!res.writableEnded && !res.destroyed && !activeRun?.controller.signal.aborted) {
          res.write(formatChatEvent(payload));
        }
      };
      const finishChatStream = (payload: Record<string, unknown>) => {
        if (streamSessionId !== undefined && !res.writableEnded && !res.destroyed) {
          res.end(formatChatEvent({ ...payload, done: true, sessionId: streamSessionId }));
        }
      };
      try {
        const body = await parseBody(req, CHAT_BODY_LIMIT_BYTES);
        const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const message = typeof data.message === "string" ? data.message.trim() : "";
        const sessionId = typeof data.sessionId === "string" ? data.sessionId.trim() : generateSessionId();
        const useStream = data.stream === true;
        const userVoiceGender =
          data.voiceGender === "male" || data.voiceGender === "female" ? data.voiceGender : undefined;
        const userVoiceEmotion =
          data.voiceEmotion === "angry" || data.voiceEmotion === "happy" || data.voiceEmotion === "neutral" || data.voiceEmotion === "sad"
            ? data.voiceEmotion
            : undefined;
        // Client-asserted vision identity: trusted only with a valid, fresh
        // HMAC signature from the recognition service (vision.recognizeSecret).
        // Anything else is rejected outright — no memory binding, no superuser
        // (Telegram/VK pass their own server-side id through runOrchestrator
        // directly and are unaffected).
        const rawRecognized = typeof data.recognizedUser === "string" ? data.recognizedUser.trim() : "";
        const recognizedUser = (() => {
          if (!rawRecognized || rawRecognized.toLowerCase() === "unknown") return undefined;
          const secret = config.vision?.recognizeSecret?.trim();
          if (!secret) {
            warnVisionNoSecretOnce(config);
            return undefined;
          }
          const check = verifyVisionClaim(secret, {
            userId: rawRecognized,
            ts: typeof data.recognizedTs === "number" ? data.recognizedTs : undefined,
            sig: typeof data.recognizedSig === "string" ? data.recognizedSig : undefined,
          });
          if (!check.ok) {
            auditLog(config, {
              type: "vision_claim_rejected",
              details: { reason: check.reason, claimed: rawRecognized.slice(0, 64) },
            });
            return undefined;
          }
          return rawRecognized;
        })();
        const rawPageContextEarly = data.pageContext;
        let pageContext: BrowserPageContext | undefined;
        if (
          rawPageContextEarly &&
          typeof rawPageContextEarly === "object" &&
          !Array.isArray(rawPageContextEarly)
        ) {
          const pc = rawPageContextEarly as Record<string, unknown>;
          const text = typeof pc.text === "string" ? pc.text.trim() : "";
          const snippet = typeof pc.snippet === "string" ? pc.snippet.trim() : "";
          const url = typeof pc.url === "string" ? pc.url.trim() : "";
          const title = typeof pc.title === "string" ? pc.title.trim() : "";
          // Selection, rendered snippet, and/or page location (W composer).
          if (text || snippet || url || title) {
            pageContext = {
              text: text || undefined,
              snippet: snippet || undefined,
              url: url || undefined,
              title: title || undefined,
            };
          }
        }
        const browserPageTextFallback =
          typeof data.browserPageText === "string" && data.browserPageText.trim()
            ? data.browserPageText.trim().slice(0, 16_000)
            : null;
        if (!message && !pageContext) {
          res.writeHead(400, { "Content-Type": JSON_TYPE });
          res.end(JSON.stringify({ error: "message required" }));
          return;
        }

        // --- /allow <skill.js>: one-time user confirmation for a skill
        // outside skills.allowlist. It arrives as a chat message from the
        // client, not as anything the model can produce. Persisted to the
        // config file, applied at once.
        // In registration (hosted) mode approving executable code is an
        // operator decision: only gateway.auth.admins may send /allow — an
        // ordinary chat message is not authorization for widening the
        // allowlist (this path used to inherit any chat-endpoint auth gap).
        const allowMatch = /^\/allow\s+([a-zA-Z0-9._-]+\.js)\s*$/i.exec(message);
        if (allowMatch) {
          if (isRegistrationMode(config)) {
            const admins = (config.gateway?.auth?.admins ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean);
            const isAdmin = !!userLogin && admins.includes(userLogin.toLowerCase());
            if (!isAdmin) {
              const content = userLogin
                ? "Команда /allow доступна только администратору (gateway.auth.admins)."
                : "Команда /allow доступна только администратору (войдите под аккаунтом из gateway.auth.admins).";
              if (useStream) {
                openChatStream(sessionId);
                writeChatEvent({ content });
                finishChatStream({ content });
              } else {
                res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
                res.end(JSON.stringify({ content, sessionId }));
              }
              auditLog(config, { type: "config_saved_denied", details: { allowSkill: allowMatch[1], userLogin } });
              return;
            }
          }
          const scriptName = allowMatch[1];
          const skillPath = join(agentsDir, scriptName);
          if (!existsSync(skillPath) || !statSync(skillPath).isFile()) {
            res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
            res.end(JSON.stringify({ content: `Нет такого навыка: ${scriptName}`, sessionId }));
            return;
          }
          const configPath = getConfigPath();
          let fileConfig: Record<string, unknown> = {};
          if (existsSync(configPath)) {
            try {
              fileConfig = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
            } catch {
              fileConfig = {};
            }
          }
          const skillsSection = (fileConfig.skills as { allowlist?: string[] } | undefined) ?? {};
          const list = new Set(skillsSection.allowlist ?? []);
          const changed = !list.has(scriptName);
          if (changed) list.add(scriptName);
          fileConfig.skills = { ...skillsSection, allowlist: [...list] };
          mkdirSync(dirname(configPath), { recursive: true });
          writeFileSync(configPath, stringifyYaml(fileConfig), "utf-8");
          const reloaded = loadConfig(configPath);
          configRef.current = reloaded;
          auditLog(reloaded, { type: "config_saved", details: { configPath, allowSkill: scriptName } });
          console.error(`[gateway] Skill allowed via /allow: ${scriptName}`);
          const content = changed
            ? `✅ Навык «${scriptName}» разрешён и добавлен в skills.allowlist. Теперь его можно запустить.`
            : `Навык «${scriptName}» уже есть в skills.allowlist.`;
          if (useStream) {
            openChatStream(sessionId);
            writeChatEvent({ content });
            finishChatStream({ content });
            return;
          }
          res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ content, sessionId }));
          return;
        }

        // The question of the turn. Known before anything is awaited, so a
        // client that attaches while the turn is still being set up sees it.
        const storedUserMessage = pageContext ? formatBrowserSelectionForHistory(message, pageContext) : message;
        activeSessionId = sessionId;
        const maxConcurrentChatRuns =
          config.gateway?.maxConcurrentChatRuns ?? DEFAULT_MAX_CONCURRENT_CHAT_RUNS;
        const begun = beginChatRun(sessionId, userId, storedUserMessage, maxConcurrentChatRuns);
        if (!begun) {
          // A gateway that is stopping comes back in a moment; a full one does not.
          const stopping = isChatShuttingDown();
          res.writeHead(stopping ? 503 : 429, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(
            JSON.stringify(
              stopping
                ? { error: "Gateway is shutting down", code: "shutting_down" }
                : {
                    error: `Too many concurrent chats (limit ${maxConcurrentChatRuns}). Wait for a running one to finish.`,
                  }
            )
          );
          return;
        }
        const run = begun.run;
        activeRun = run;
        const signal = run.controller.signal;
        // A background turn outlives this request: a dropped connection only
        // unsubscribes. Without background runs it cancels the turn, as before.
        const backgroundRuns = config.gateway?.backgroundChatRuns !== false;
        const keepaliveMs = config.gateway?.chatKeepaliveMs ?? DEFAULT_CHAT_KEEPALIVE_MS;
        onRequestAborted = () => {
          if (!backgroundRuns) run.controller.abort("HTTP request aborted");
        };
        onResponseClose = () => {
          if (!backgroundRuns && !res.writableEnded) run.controller.abort("HTTP response disconnected");
        };
        req.once("aborted", onRequestAborted);
        res.once("close", onResponseClose);
        throwIfAborted(signal);
        // The turn this one superseded is stored first, so the new turn's history has it.
        if (begun.previous) {
          const settleWaitMs = config.gateway?.chatRunSettleWaitMs ?? DEFAULT_CHAT_RUN_SETTLE_WAIT_MS;
          if (!(await waitForChatRun(begun.previous, settleWaitMs))) {
            console.error(
              `[gateway] the previous turn of chat ${sessionId} is still stopping ${settleWaitMs} ms after it was superseded; the new turn starts without it in its history`
            );
          }
          throwIfAborted(signal);
        }
        const messageForTitle = message || pageContext?.text?.slice(0, 80) || "browser";
        let chatRepo = getChatRepository();
        if (!chatRepo && config.gateway?.chatsDbPath) {
          chatRepo = initDb(resolve(process.cwd(), config.gateway.chatsDbPath));
        }
        const projectIdFromBody =
          typeof data.project_id === "string"
            ? data.project_id.trim() || null
            : data.project_id === null
              ? null
              : undefined;
        if (chatRepo) {
          const preferredTitle =
            (typeof data.chatTitle === "string" && data.chatTitle.trim()) ||
            pageContext?.title?.trim() ||
            "";
          const title = preferredTitle || deriveChatTitleFromRequest(messageForTitle);
          const browserPageKeyRaw =
            typeof data.browserPageKey === "string"
              ? data.browserPageKey.trim()
              : typeof data.browser_page_key === "string"
                ? data.browser_page_key.trim()
                : "";
          const browserPageKey = browserPageKeyRaw || undefined;
          chatRepo.ensureChat(sessionId, userId, title, projectIdFromBody, browserPageKey ?? null);
          // Browser page title may arrive after the first message was titled from the prompt.
          // A manually renamed chat keeps its name: auto-titling must not overwrite it.
          if (preferredTitle && !chatRepo.isTitleManual(sessionId, userId)) {
            chatRepo.updateChatTitle(sessionId, userId, preferredTitle);
          }
          if (browserPageKey) {
            chatRepo.updateChatBrowserPageKey(sessionId, userId, browserPageKey);
          }
        }
        const projectIdForContext =
          projectIdFromBody !== undefined
            ? projectIdFromBody
            : chatRepo
              ? chatRepo.getChatProjectId(sessionId, userId)
              : null;
        const projectCtx =
          projectIdForContext && chatRepo
            ? chatRepo.getProjectLlmContext(userId, projectIdForContext, sessionId)
            : null;
        const projectName = projectCtx?.name;
        const projectDescription = projectCtx?.description;
        const projectSiblingDigests = projectCtx?.siblings.map((s) => ({
          title: s.title,
          digest: s.digest,
        }));
        const chatWithoutProject = !!chatRepo && projectIdForContext == null;
        // Tool steps of earlier turns ride on the assistant message of their
        // turn, which sits right after the user message the trace is tied to.
        const stepsByTurn = new Map<number, ToolTraceEntry[]>();
        for (const call of chatRepo ? chatRepo.listToolCalls(sessionId, userId) : []) {
          const steps = stepsByTurn.get(call.turnIndex) ?? [];
          steps.push({
            seq: call.step,
            iteration: call.iteration,
            name: call.name,
            args: call.args,
            ...(call.result != null && { result: call.result }),
            ...(call.ok != null && { ok: call.ok }),
            ...(call.durationMs != null && { durationMs: call.durationMs }),
            untrusted: call.untrusted,
          });
          stepsByTurn.set(call.turnIndex, steps);
        }
        const fullHistory: TraceHistoryMessage[] = chatRepo
          ? chatRepo.getMessages(sessionId, userId).map((m, index) => ({
              role: m.role,
              content:
                m.role === "assistant" ? contentForLlmHistory(m.content, m.meta) : m.content,
              ...(m.role === "assistant" && stepsByTurn.has(index - 1) && { tools: stepsByTurn.get(index - 1) }),
            }))
          : getSessionHistory(sessionId);
        const promptCtx = chatRepo
          ? chatRepo.getPromptContext(sessionId, userId)
          : getSessionPromptContext(sessionId);
        const historyForLlm = applyPromptContext(fullHistory, promptCtx);
        const maxTurns = config.gateway?.maxHistoryTurns ?? 10;
        const history = limitHistoryForPrompt(historyForLlm, 2 * maxTurns);
        const fullLengthBeforeAppend = fullHistory.length;
        const historyLenForLlm = history.length;
        const wrapped = composeWebchatUserPayload(
          message ||
            (pageContext?.text?.trim()
              ? "Explain the selected text."
              : pageContext
                ? "Ask about the page."
                : ""),
          pageContext
        );
        // Browser page text is web content riding in the user message: mark
        // provenance so later turns (and the trifecta) know it is there.
        const userOrigin = pageContext ? { source: "browser-page" as const, untrusted: true } : undefined;
        if (pageContext) markUntrustedOrigin(sessionId);
        let effectiveConfig: Claw2Config = config;
        if (isRegistrationMode(config) && userId !== "default") {
          const repo = getAuthRepo(config);
          const userConfig = await getCachedUserConfig(repo, userId);
          effectiveConfig = getEffectiveConfig(config, userConfig);
        }
        auditConfig = effectiveConfig;
        throwIfAborted(signal);
        // Per-chat model override (settings keep the global default).
        // Prefer body (client sends current picker value), then persisted chats.model.
        const bodyModel =
          typeof data.model === "string" && data.model.trim() ? data.model.trim() : "";
        const storedModel = chatRepo ? chatRepo.getChatModel(sessionId, userId) : null;
        const chatModel = bodyModel || storedModel || null;
        if (chatModel && chatRepo) {
          // Keep DB in sync when client sends override (or first message after picker change).
          if (chatModel !== storedModel) {
            chatRepo.updateChatModel(sessionId, userId, chatModel);
          }
        }
        if (chatModel) {
          const baseLlm = effectiveConfig.llm ?? { provider: "openai" as const, model: chatModel };
          effectiveConfig = {
            ...effectiveConfig,
            llm: { ...baseLlm, model: chatModel },
          };
        }
        const raw = data.documents;
        const attachedDocuments =
          Array.isArray(raw) && raw.length > 0
            ? saveUploadedDocuments(raw as IncomingDocument[], sessionId, effectiveConfig)
            : [];
        const tenantEndpointError = await assertTenantLlmEndpointPublic(config, userId, effectiveConfig);
        if (tenantEndpointError) {
          if (useStream) {
            openChatStream(sessionId);
            finishChatStream({ error: tenantEndpointError, code: "endpoint_not_allowed" });
          } else {
            res.writeHead(403, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
            res.end(JSON.stringify({ error: tenantEndpointError, code: "endpoint_not_allowed" }));
          }
          return;
        }
        const chatStartMs = Date.now();
        const llmReady = assessLlmConfigured(effectiveConfig);
        if (!llmReady.ok) {
          const errMsg =
            llmReady.reason ||
            "LLM not configured. Open Settings or complete setup (baseURL + API key).";
          if (useStream) {
            openChatStream(sessionId);
            finishChatStream({ error: errMsg, code: "llm_not_configured" });
            return;
          }
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: errMsg, code: "llm_not_configured" }));
          return;
        }
        const transcriptAccess =
          chatRepo && isTranscriptToolsEnabled(effectiveConfig)
            ? createTranscriptSessionAccess(chatRepo, sessionId, userId)
            : undefined;

        let insightAddendum: string | undefined;
        const rawInsightCtx = data.clientInsightContext;
        if (rawInsightCtx && typeof rawInsightCtx === "object" && !Array.isArray(rawInsightCtx)) {
          const ic = rawInsightCtx as Record<string, unknown>;
          const pastChatId = typeof ic.pastChatId === "string" ? ic.pastChatId.trim() : "";
          const reasonCode = typeof ic.reasonCode === "string" ? ic.reasonCode.trim() : "";
          const insightTopic = typeof ic.insightTopic === "string" ? ic.insightTopic.trim() : "";
          const currentBrief = typeof ic.currentBrief === "string" ? ic.currentBrief.trim() : "";
          const excerpts = Array.isArray(ic.excerpts)
            ? ic.excerpts.filter((e): e is string => typeof e === "string" && e.trim().length > 0)
            : [];
          if (pastChatId && reasonCode && excerpts.length) {
            const ctx: ClientInsightContext = {
              pastChatId,
              reasonCode: reasonCode as InsightReasonCode,
              insightTopic: insightTopic || "related",
              excerpts,
              currentBrief,
            };
            const title =
              typeof ic.pastChatTitle === "string" && ic.pastChatTitle.trim()
                ? ic.pastChatTitle.trim()
                : "Past chat";
            const formulated =
              typeof ic.formulatedText === "string" ? ic.formulatedText.trim() : undefined;
            insightAddendum = formatInsightAddendum({
              pastChatTitle: title,
              reasonCode: ctx.reasonCode,
              excerpts: ctx.excerpts,
              formulatedText: formulated,
            });
          }
        }

        const pageKeyForInsight =
          (typeof data.browserPageKey === "string" && data.browserPageKey.trim()) ||
          (typeof data.browser_page_key === "string" && data.browser_page_key.trim()) ||
          pageContext?.url ||
          "";
        const linkerPromise: Promise<InsightOffer | null> =
          effectiveConfig.insights?.enabled !== false &&
          (effectiveConfig.insights?.mode ?? "ask") !== "off" &&
          chatRepo
            ? getInsightOfferWithBudget(
                {
                  userId,
                  sessionId,
                  userText: message || pageContext?.text || "",
                  pageTitle: pageContext?.title,
                  pageKey: pageKeyForInsight || undefined,
                  projectId: projectIdForContext,
                },
                {
                  config: effectiveConfig,
                  chatRepo,
                  siblings: (projectCtx?.siblings ?? []).map((s) => ({
                    id: s.id,
                    title: s.title,
                    digest: s.digest,
                  })),
                }
              )
            : Promise.resolve(null);

        const resolveInsightOffer = async (): Promise<InsightOffer | null> => {
          let offer = await linkerPromise;
          if (!offer) return null;
          const mode = effectiveConfig.insights?.mode ?? "ask";
          if (mode === "auto") {
            const dateLabel = new Date(offer.pastChatUpdatedAt).toISOString().slice(0, 10);
            const text = await runCheapPass(effectiveConfig, {
              pastChatTitle: offer.pastChatTitle,
              dateLabel,
              reasonCode: offer.reasonCode,
              currentBrief: (message || pageContext?.text || pageContext?.title || "").slice(0, 600),
              excerpts: offer.excerpts,
            });
            if (text) offer = { ...offer, text };
          }
          auditLog(effectiveConfig, {
            type: "insight_offered",
            sessionId,
            details: {
              reasonCode: offer.reasonCode,
              pastChatId: offer.pastChatId,
              score: offer.score,
              mode,
            },
          });
          return offer;
        };

        // Both response formats use the same commit path. Do not send a terminal
        // result until the full turn (including any prompt recap) is durable.
        const persistTurn = (
          result: Pick<
            Awaited<ReturnType<typeof runOrchestrator>>,
            "content" | "cells" | "summaryForHistory" | "summaryDropCount"
          >,
          tools?: ToolTraceEntry[],
          interruptedBy?: InterruptedBy
        ) => {
          const userCells = imageCellsFromUploads(attachedDocuments);
          const summary = result.summaryForHistory;
          const coveredCount = nextPromptCoveredCount(
            fullLengthBeforeAppend, historyLenForLlm, result.summaryDropCount ?? 0
          );
          const promptContext = summary != null && coveredCount > 0 ? { summary, coveredCount } : undefined;
          if (chatRepo) {
            chatRepo.appendTurn(
              sessionId,
              userId,
              { content: storedUserMessage, meta: cellsToMeta(userCells) },
              { content: result.content, meta: cellsToMeta(result.cells ?? [], interruptedBy) },
              promptContext,
              tools
            );
          } else {
            appendToSession(sessionId, "user", storedUserMessage, userOrigin);
            appendToSession(
              sessionId,
              "assistant",
              result.content,
              hasUntrustedOrigin(sessionId) ? { source: "derived", untrusted: true } : undefined,
              tools
            );
            if (promptContext) {
              setSessionPromptContext(sessionId, promptContext.summary, promptContext.coveredCount);
            }
          }
          markChatRunStored(run);
          return userCells;
        };

        // Live events of the turn go to whoever is listening — this request,
        // or a client that re-attached. The full tool result stays on the server.
        const toolEvents: ToolEvent[] = [];
        const openedBrowserUrls: string[] = [];
        const publish = (event: ChatRunEvent) => publishChatRun(run, event);
        const chatTurnAudit = (details: Record<string, unknown>) =>
          auditLog(effectiveConfig, {
            type: "chat_turn",
            sessionId,
            details: {
              hasAttachments: attachedDocuments.length > 0,
              model: effectiveConfig.llm?.model,
              chatModelOverride: chatModel || undefined,
              ...details,
            },
          });

        /**
         * A stopped turn keeps its message, the text printed so far and its tool
         * steps — when there is anything to keep — marked with what cut it short.
         */
        const persistStoppedTurn = (interruptedBy?: InterruptedBy) => {
          const tools = foldToolEvents(toolEvents);
          if (!run.partialContent.trim() && tools.length === 0) return;
          // Superseded, and the turn that replaced it is stored already: stored
          // now, it would land after it as the chat's latest exchange.
          if (hasStoredSuccessor(run)) {
            console.error(
              `[gateway] the superseded turn of chat ${sessionId} stopped after the new one was stored; it is not stored`
            );
            return;
          }
          try {
            persistTurn({ content: run.partialContent, cells: [] }, tools, interruptedBy);
          } catch (err) {
            // The chat may already be gone (deleted while the turn was stopping).
            console.error(
              `[gateway] stopped turn of ${sessionId} was not stored:`,
              err instanceof Error ? err.message : err
            );
          }
        };

        // The turn itself — model, tools, insight offer, storage — runs on its
        // own, not inside this request, so it outlives a dropped connection.
        const execute = async (): Promise<void> => {
          const capMs = config.gateway?.chatRunMaxMs ?? DEFAULT_CHAT_RUN_MAX_MS;
          const cap = capMs > 0 ? setTimeout(() => run.controller.abort("Chat run timeout"), capMs) : null;
          try {
            const result = await runOrchestrator({
              config: effectiveConfig,
              userMessage: wrapped,
              sessionHistory: history,
              attachedDocuments: attachedDocuments.length > 0 ? attachedDocuments : undefined,
              userVoiceGender,
              userVoiceEmotion,
              recognizedUser,
              projectName,
              projectDescription,
              projectSiblingDigests,
              chatWithoutProject,
              insightAddendum,
              sessionId,
              signal,
              transcript: transcriptAccess,
              // Non-stream clients keep the non-streaming model call they always had.
              ...(useStream ? { onStreamChunk: (chunk: string) => publish({ content: chunk }) } : {}),
              onToolEvent: (event: ToolEvent) => {
                toolEvents.push(event);
                publish({ toolEvent: toStepEvent(event) });
              },
              onSidebarUpdated: () => publish({ sidebarUpdated: true }),
              onOpenBrowserUrl: (url: string) => {
                openedBrowserUrls.push(url);
                publish({ openBrowserUrl: url });
              },
              browserPageTextFallback,
              requestBrowserPageText: async () => {
                const requestId = randomBytes(8).toString("hex");
                const wait = waitForBrowserPageText(requestId, 18_000, signal);
                publish({ readBrowserPage: { requestId } });
                return wait;
              },
              requestHeadlessPageText: async (pageUrl: string) => {
                const requestId = randomBytes(8).toString("hex");
                const wait = waitForBrowserPageText(requestId, 20_000, signal);
                publish({ headlessPageText: { requestId, url: pageUrl } });
                return wait;
              },
            });
            throwIfAborted(signal);
            const insightOffer = await resolveInsightOffer();
            throwIfAborted(signal);
            const userCells = persistTurn(result, result.tools);
            chatTurnAudit({
              toolIterations: result.toolIterations,
              toolCalls: result.tools?.length ?? 0,
              toolLimitReached: result.toolLimitReached === true,
              error: result.error,
              durationMs: Date.now() - chatStartMs,
            });
            finishChatRun(run, {
              content: result.content,
              error: result.error ?? undefined,
              lastRunId: result.lastRunId ?? undefined,
              cells: result.cells ?? undefined,
              userCells,
              contextCompressed: result.contextCompressed,
              sidebarUpdated: result.sidebarUpdated,
              toolLimitReached: result.toolLimitReached,
              insightOffer: insightOffer ?? undefined,
            });
          } catch (err) {
            if (signal.aborted || isAbortError(err)) {
              // Keep what the turn managed to do: a long run must not vanish
              // because it was stopped. A connection that merely dropped while
              // background runs are off is not a stop — as before, nothing is stored.
              const reason = run.controller.signal.reason ? String(run.controller.signal.reason) : "";
              const connectionLost = reason === "HTTP response disconnected" || reason === "HTTP request aborted";
              // Stopped by the gateway going down: the answer is not to read as one the user stopped.
              const gatewayRestart = reason === SHUTDOWN_ABORT_REASON;
              if (!connectionLost) persistStoppedTurn(gatewayRestart ? "gateway_restart" : undefined);
              auditLog(auditConfig, {
                type: "chat_cancelled",
                sessionId,
                details: {
                  reason: reason || String(err),
                  durationMs: Date.now() - requestStartMs,
                  toolSteps: toolEvents.filter((event) => event.type === "start").length,
                },
              });
              finishChatRun(
                run,
                gatewayRestart
                  ? { error: "Gateway is restarting", code: "gateway_restart" }
                  : { error: "Chat cancelled", code: "chat_cancelled" }
              );
            } else {
              chatTurnAudit({ error: String(err), durationMs: Date.now() - chatStartMs });
              finishChatRun(run, { error: String(err) });
            }
          } finally {
            if (cap) clearTimeout(cap);
          }
        };
        if (useStream) {
          openChatStream(sessionId);
          const stopKeepalive = startSseKeepalive(res, keepaliveMs);
          const unsubscribe = subscribeChatRun(run, (event) => {
            if ("terminal" in event) {
              stopKeepalive();
              finishChatStream({ ...event.terminal });
              return;
            }
            writeChatEvent(event);
          });
          handedOff = true;
          // The response now belongs to the run; it unsubscribes when the client goes away.
          res.once("close", () => {
            unsubscribe();
            stopKeepalive();
          });
        }

        // Started only once the stream is subscribed: no event is lost, not
        // even one the turn emits before its first await.
        void execute().catch((err) => {
          finishChatRun(run, { error: `Internal error: ${String(err)}` });
        });

        if (!useStream) {
          await run.done;
          if (res.writableEnded || res.destroyed) return;
          const terminal = run.terminal ?? { error: "Chat run ended without a result" };
          // A turn that was stopped — by the user or by the gateway going down — is not a failed request.
          const stopped = terminal.code === "chat_cancelled" || terminal.code === "gateway_restart";
          res.writeHead(terminal.error && !stopped ? 500 : 200, {
            "Content-Type": JSON_TYPE,
            "Access-Control-Allow-Origin": corsOrigin,
            "X-Session-Id": sessionId,
          });
          res.end(
            JSON.stringify({
              sessionId,
              ...terminal,
              ...(openedBrowserUrls.length ? { openBrowserUrls: openedBrowserUrls } : {}),
            })
          );
          return;
        }
      } catch (err) {
        // Setup failed before the turn got an executor of its own.
        const cancelled = activeRun?.controller.signal.aborted === true || isAbortError(err);
        if (cancelled) {
          auditLog(auditConfig, {
            type: "chat_cancelled",
            sessionId: activeSessionId || undefined,
            details: {
              reason: activeRun?.controller.signal.reason
                ? String(activeRun.controller.signal.reason)
                : String(err),
              durationMs: Date.now() - requestStartMs,
            },
          });
          if (streamSessionId !== undefined) {
            finishChatStream({ error: "Chat cancelled", code: "chat_cancelled" });
          } else if (!res.writableEnded && !res.destroyed) {
            res.end();
          }
        } else if (streamSessionId !== undefined) {
          finishChatStream({ error: String(err) });
        } else if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": JSON_TYPE });
          res.end(JSON.stringify({ error: String(err) }));
        }
        // Release the session slot: nothing else will finish this run.
        if (activeRun && !activeRun.terminal) {
          finishChatRun(activeRun, {
            error: cancelled ? "Chat cancelled" : String(err),
            code: cancelled ? "chat_cancelled" : undefined,
          });
        }
      } finally {
        if (!handedOff) {
          if (onRequestAborted) req.removeListener("aborted", onRequestAborted);
          if (onResponseClose) res.removeListener("close", onResponseClose);
          // The request turned back before the turn started (provider not
          // configured, bad endpoint): release the slot, or the next message
          // of this chat would wait for a turn that never runs.
          if (activeRun && !activeRun.terminal) {
            finishChatRun(activeRun, { error: "Chat request ended before the turn started" });
          }
        }
      }
      return;
    }

    // —— Dialogue Insights accept / dismiss / idle ——
    if (req.method === "POST" && (p === "/chat/insight/accept" || p === "/chat/insight/dismiss")) {
      try {
        const body = await parseBody(req);
        const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const chatId = typeof data.chatId === "string" ? data.chatId.trim() : "";
        const pastChatId =
          typeof data.pastChatId === "string" ? data.pastChatId.trim() : undefined;
        const reasonCode = typeof data.reasonCode === "string" ? data.reasonCode.trim() : "";
        const insightTopic =
          typeof data.insightTopic === "string" ? data.insightTopic.trim() : "";
        const score = typeof data.score === "number" ? data.score : undefined;
        if (!chatId || !reasonCode) {
          res.writeHead(400, { "Content-Type": JSON_TYPE });
          res.end(JSON.stringify({ error: "chatId and reasonCode required" }));
          return;
        }
        let chatRepo = getChatRepository();
        if (!chatRepo && config.gateway?.chatsDbPath) {
          chatRepo = initDb(resolve(process.cwd(), config.gateway.chatsDbPath));
        }
        if (!chatRepo) {
          res.writeHead(503, { "Content-Type": JSON_TYPE });
          res.end(JSON.stringify({ error: "chats db unavailable" }));
          return;
        }
        const status = p.endsWith("/accept") ? ("accepted" as const) : ("dismissed" as const);
        const eventId = insightStoreRecordDecision(chatRepo, {
          userId,
          chatId,
          pastChatId,
          reasonCode,
          insightTopic: insightTopic || "related",
          score,
          status,
        });
        auditLog(config, {
          type: status === "accepted" ? "insight_accepted" : "insight_dismissed",
          sessionId: chatId,
          details: { pastChatId, reasonCode, insightTopic, eventId },
        });

        let text: string | undefined;
        if (status === "accepted") {
          const excerpts = Array.isArray(data.excerpts)
            ? data.excerpts.filter((e): e is string => typeof e === "string" && !!e.trim())
            : [];
          const currentBrief =
            typeof data.currentBrief === "string" ? data.currentBrief.trim() : "";
          const pastChatTitle =
            typeof data.pastChatTitle === "string" && data.pastChatTitle.trim()
              ? data.pastChatTitle.trim()
              : "Past chat";
          const dateLabel =
            typeof data.dateLabel === "string" && data.dateLabel.trim()
              ? data.dateLabel.trim()
              : new Date().toISOString().slice(0, 10);
          if (currentBrief && excerpts.length) {
            text =
              (await runCheapPass(config, {
                pastChatTitle,
                dateLabel,
                reasonCode: reasonCode as InsightReasonCode,
                currentBrief,
                excerpts,
              })) ?? undefined;
          }
        }

        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ ok: true, eventId, text }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "GET" && p === "/chat/insight/idle") {
      try {
        const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
        const sessionId = url.searchParams.get("session_id")?.trim() || "";
        if (!sessionId) {
          res.writeHead(400, { "Content-Type": JSON_TYPE });
          res.end(JSON.stringify({ error: "session_id required" }));
          return;
        }
        let chatRepo = getChatRepository();
        if (!chatRepo && config.gateway?.chatsDbPath) {
          chatRepo = initDb(resolve(process.cwd(), config.gateway.chatsDbPath));
        }
        if (!chatRepo || config.insights?.enabled === false || (config.insights?.mode ?? "ask") === "off") {
          res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ insightOffer: null }));
          return;
        }
        const projectId = chatRepo.getChatProjectId(sessionId, userId);
        const projectCtx =
          projectId ? chatRepo.getProjectLlmContext(userId, projectId, sessionId) : null;
        const pageTitle = url.searchParams.get("page_title")?.trim() || undefined;
        const pageKey = url.searchParams.get("page_key")?.trim() || undefined;
        const offer = await getInsightOfferWithBudget(
          {
            userId,
            sessionId,
            userText: "",
            pageTitle,
            pageKey,
            projectId,
            idleScan: true,
          },
          {
            config,
            chatRepo,
            siblings: (projectCtx?.siblings ?? []).map((s) => ({
              id: s.id,
              title: s.title,
              digest: s.digest,
            })),
          }
        );
        if (offer) {
          auditLog(config, {
            type: "insight_offered",
            sessionId,
            details: { reasonCode: offer.reasonCode, pastChatId: offer.pastChatId, idle: true },
          });
        }
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ insightOffer: offer }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "GET" && p === "/api/sidebar") {
      try {
        const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
        const sessionId = url.searchParams.get("sessionId")?.trim() || "anon";
        const { sidebarGet } = await import("../sidebar/store.js");
        const state = sidebarGet(sessionId);
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify(state));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (req.method === "POST" && p === "/api/sidebar/click") {
      try {
        const body = await parseBody(req);
        const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const sessionId =
          typeof data.sessionId === "string" && data.sessionId.trim()
            ? data.sessionId.trim()
            : "anon";
        const itemId = typeof data.itemId === "string" ? data.itemId.trim() : "";
        if (!itemId) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "itemId required" }));
          return;
        }
        const { sidebarClick } = await import("../sidebar/store.js");
        const result = sidebarClick(sessionId, itemId);
        if (!result.ok) {
          res.writeHead(404, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: result.error }));
          return;
        }
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ ok: true, state: result.state, item: result.item }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (req.method === "GET" && p === "/chat/list") {
      const listUrl = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
      const searchQ = listUrl.searchParams.get("q")?.trim() ?? "";
      const projectIdParam = listUrl.searchParams.get("project_id")?.trim() ?? "";
      const projectId = projectIdParam || null;
      let chatRepo = getChatRepository();
      if (!chatRepo && config.gateway?.chatsDbPath) {
        chatRepo = initDb(resolve(process.cwd(), config.gateway.chatsDbPath));
      }
      if (!chatRepo) {
        res.writeHead(503, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Chats DB not configured (gateway.chatsDbPath)" }));
        return;
      }
      try {
        const chats = searchQ ? chatRepo.searchChats(userId, searchQ) : chatRepo.listChats(userId, projectId);
        if (!searchQ) {
          // Sidebar attachment indicators: image cells / document references in
          // messages, plus session-prefixed files on disk (uploads the user
          // attached, files the agent saved — they are not always quoted in text).
          // Forked chats also inherit their ancestors' files: the documents
          // panel shows them, so the icon must light up the same way.
          const refs = chatRepo.attachmentRefsByChat(userId);
          const byId = new Map(chats.map((c) => [c.id, c]));
          const idsWithAncestors = new Map<string, string[]>();
          for (const chat of chats) {
            const ids = [chat.id];
            let cursor = chat.forked_from_chat_id ?? null;
            for (let depth = 0; cursor && depth < 10; depth++) {
              ids.push(cursor);
              cursor = byId.get(cursor)?.forked_from_chat_id ?? null;
            }
            idsWithAncestors.set(chat.id, ids);
          }
          const diskFlags = new Map<string, { images: boolean; docs: boolean }>();
          const markDisk = (name: string) => {
            for (const chat of chats) {
              if (!(idsWithAncestors.get(chat.id) ?? []).some((id) => name.startsWith(id))) continue;
              const cur = diskFlags.get(chat.id) ?? { images: false, docs: false };
              if (isImagePath(name)) cur.images = true;
              else if (isDocumentPath(name)) cur.docs = true;
              diskFlags.set(chat.id, cur);
            }
          };
          for (const dir of [outputDir, uploadsDir]) {
            try {
              for (const name of readdirSync(dir)) markDisk(name);
            } catch {
              /* directory missing — nothing on disk */
            }
          }
          for (const chat of chats) {
            const fromMessages = refs.get(chat.id);
            const fromDisk = diskFlags.get(chat.id);
            chat.hasImages = !!(fromMessages?.images || fromDisk?.images);
            chat.hasDocs = !!(fromMessages?.docs || fromDisk?.docs);
          }
        }
        // A turn is still running for these chats (it outlives the request that started it).
        for (const chat of chats) {
          const running = getChatRun(chat.id);
          if (running && running.userId === userId) chat.running = true;
        }
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ chats }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (req.method === "POST" && p === "/chat/cancel") {
      let sessionId = "";
      try {
        const body = await parseBody(req);
        const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        sessionId = typeof data.sessionId === "string" ? data.sessionId.trim() : "";
      } catch {
        sessionId = "";
      }
      if (!sessionId) {
        res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "sessionId required" }));
        return;
      }
      // Only the owner may stop a turn; another user's session answers as if nothing were running.
      const running = getChatRun(sessionId);
      if (running && running.userId === userId) abortChatRun(sessionId, "Chat cancelled");
      res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && p === "/chat/attach") {
      const attachUrl = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
      const sessionId = attachUrl.searchParams.get("session_id")?.trim();
      if (!sessionId) {
        res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "session_id required" }));
        return;
      }
      const frame = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
      const run = getChatRun(sessionId);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": corsOrigin,
        "X-Session-Id": sessionId,
      });
      res.on("error", () => {
        /* the client went away */
      });
      res.flushHeaders();
      if (!run || run.userId !== userId) {
        res.end(frame({ done: true, noRun: true, sessionId }));
        return;
      }
      // Catch up on what happened before this client connected: the question
      // being answered (stored only when the turn ends), the text and the steps so far.
      if (run.partialContent || run.steps.length > 0 || run.userMessage) {
        res.write(frame({ snapshot: { userMessage: run.userMessage, content: run.partialContent, steps: run.steps } }));
      }
      if (run.sidebarUpdated) res.write(frame({ sidebarUpdated: true }));
      // What the turn asked of a client's browser is asked again: a page it
      // opened while nobody was listening, and a page-text request that is
      // still waiting — the client that just connected can answer it.
      if (run.missedOpenUrl) {
        res.write(frame({ openBrowserUrl: run.missedOpenUrl }));
        run.missedOpenUrl = undefined;
      }
      for (const request of run.pageRequests) {
        if (!isBrowserPageTextPending(request.requestId)) continue;
        res.write(
          frame(request.url ? { headlessPageText: request } : { readBrowserPage: { requestId: request.requestId } })
        );
      }
      // No await between reading the run and subscribing: a turn that ends in
      // between would otherwise leave this stream waiting forever.
      const stopKeepalive = startSseKeepalive(res, config.gateway?.chatKeepaliveMs ?? DEFAULT_CHAT_KEEPALIVE_MS);
      const unsubscribe = subscribeChatRun(run, (event) => {
        if (res.writableEnded || res.destroyed) return;
        if ("terminal" in event) {
          stopKeepalive();
          res.end(frame({ ...event.terminal, done: true, sessionId }));
          return;
        }
        res.write(frame(event));
      });
      res.once("close", () => {
        unsubscribe();
        stopKeepalive();
      });
      return;
    }
    if (req.method === "GET" && p === "/chat/history") {
      const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
      const sessionId = url.searchParams.get("session_id")?.trim();
      if (!sessionId) {
        res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "session_id required" }));
        return;
      }
      let chatRepo = getChatRepository();
      if (!chatRepo && config.gateway?.chatsDbPath) {
        chatRepo = initDb(resolve(process.cwd(), config.gateway.chatsDbPath));
      }
      if (!chatRepo) {
        res.writeHead(503, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Chats DB not configured (gateway.chatsDbPath)" }));
        return;
      }
      try {
        // The UI gets the steps of each turn (name, short arguments, outcome) — never their results.
        const stepsByTurn = new Map<number, Array<{ name: string; args: string; ok: boolean | null; durationMs: number | null }>>();
        for (const call of chatRepo.listToolCalls(sessionId, userId)) {
          const steps = stepsByTurn.get(call.turnIndex) ?? [];
          steps.push({
            name: call.name,
            args: clipHeadTail(call.args, TOOL_STEP_ARGS_CHARS).text,
            ok: call.ok,
            durationMs: call.durationMs,
          });
          stepsByTurn.set(call.turnIndex, steps);
        }
        const messages = chatRepo.getChatHistory(sessionId, userId).map((m, index) => {
          const resolved = resolveAssistantCells(m.content, m.meta);
          const payload: {
            role: string;
            content: string;
            cells?: typeof resolved.cells;
            attachedFiles?: { name: string; previewUrl?: string; deleted?: boolean }[];
            tools?: Array<{ name: string; args: string; ok: boolean | null; durationMs: number | null }>;
            /** What cut the answer short: `gateway_restart` when the gateway stopped while it was being written. */
            interruptedBy?: InterruptedBy;
          } = {
            role: m.role,
            content: resolved.content,
          };
          // The assistant message of a turn sits right after the user message its trace is tied to.
          if (m.role === "assistant" && stepsByTurn.has(index - 1)) {
            payload.tools = stepsByTurn.get(index - 1);
          }
          if (resolved.cells.length > 0) payload.cells = resolved.cells;
          const interruptedBy = m.role === "assistant" ? interruptedByFromMeta(m.meta) : undefined;
          if (interruptedBy) payload.interruptedBy = interruptedBy;
          if (m.role === "user" && resolved.cells.length > 0) {
            const attached = resolved.cells
              .filter((c) => c.type === "image" || c.type === "image_deleted")
              .map((c) => {
                const url = (c.content ?? "").trim();
                const name = url.split("/").filter(Boolean).pop() || "image";
                const deleted = c.type === "image_deleted";
                return {
                  name,
                  previewUrl: deleted ? undefined : url,
                  deleted,
                };
              });
            if (attached.length) payload.attachedFiles = attached;
          }
          return payload;
        });
        if (messages.length === 0) {
          const exists = chatRepo.listChats(userId).some((c) => c.id === sessionId);
          if (!exists) {
            res.writeHead(404, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
            res.end(JSON.stringify({ error: "Chat not found or access denied" }));
            return;
          }
        }
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ messages }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (req.method === "GET" && p === "/chat/search") {
      const searchUrl = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
      const q = searchUrl.searchParams.get("q")?.trim() ?? "";
      let chatRepo = getChatRepository();
      if (!chatRepo && config.gateway?.chatsDbPath) {
        chatRepo = initDb(resolve(process.cwd(), config.gateway.chatsDbPath));
      }
      if (!chatRepo) {
        res.writeHead(503, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Chats DB not configured (gateway.chatsDbPath)" }));
        return;
      }
      try {
        const results = q ? chatRepo.searchMessages(userId, q) : [];
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ results }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (req.method === "PATCH" && p === "/chat") {
      let chatRepo = getChatRepository();
      if (!chatRepo && config.gateway?.chatsDbPath) {
        chatRepo = initDb(resolve(process.cwd(), config.gateway.chatsDbPath));
      }
      if (!chatRepo) {
        res.writeHead(503, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Chats DB not configured (gateway.chatsDbPath)" }));
        return;
      }
      try {
        const body = await parseBody(req);
        const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const sessionId = typeof data.session_id === "string" ? data.session_id.trim() : "";
        const projectId = typeof data.project_id === "string" ? (data.project_id.trim() || null) : data.project_id === null ? null : undefined;
        const title = typeof data.title === "string" ? data.title.trim() : "";
        const browserPageKey =
          typeof data.browser_page_key === "string"
            ? data.browser_page_key.trim() || null
            : typeof data.browserPageKey === "string"
              ? data.browserPageKey.trim() || null
              : data.browser_page_key === null || data.browserPageKey === null
                ? null
                : undefined;
        const modelPatch =
          typeof data.model === "string"
            ? data.model.trim() || null
            : data.model === null
              ? null
              : undefined;
        const pinnedPatch =
          typeof data.pinned === "boolean"
            ? data.pinned
            : data.pinned === 0 || data.pinned === 1
              ? data.pinned === 1
              : undefined;
        const favoritedPatch =
          typeof data.favorited === "boolean"
            ? data.favorited
            : data.favorited === 0 || data.favorited === 1
              ? data.favorited === 1
              : undefined;
        if (!sessionId) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "session_id required" }));
          return;
        }
        let ok = true;
        if (title) {
          // UI rename: marks the title manual so automatic titling never overwrites it.
          ok = chatRepo.renameChatTitle(sessionId, userId, title) && ok;
        }
        if (browserPageKey !== undefined) {
          ok = chatRepo.updateChatBrowserPageKey(sessionId, userId, browserPageKey) && ok;
        }
        if (modelPatch !== undefined) {
          ok = chatRepo.updateChatModel(sessionId, userId, modelPatch) && ok;
        }
        if (pinnedPatch !== undefined) {
          ok = chatRepo.updateChatPinned(sessionId, userId, pinnedPatch) && ok;
        }
        if (favoritedPatch !== undefined) {
          ok = chatRepo.updateChatFavorited(sessionId, userId, favoritedPatch) && ok;
        }
        if (projectId !== undefined) {
          ok = chatRepo.updateChatProject(sessionId, userId, projectId ?? null) && ok;
        }
        if (data.touch === true) {
          ok = chatRepo.touchChatUpdatedAt(sessionId, userId) && ok;
        }
        const model =
          modelPatch !== undefined
            ? chatRepo.getChatModel(sessionId, userId) ?? modelPatch
            : chatRepo.getChatModel(sessionId, userId);
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(
          JSON.stringify({
            ok,
            model: model ?? null,
            pinned: pinnedPatch,
            favorited: favoritedPatch,
          })
        );
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (req.method === "POST" && p === "/chat/duplicate") {
      // Fork a chat: full duplicate (no up_to_count) or a branch cut at the first
      // up_to_count messages. Files stay shared — the copy carries /files/ links only.
      let chatRepo = getChatRepository();
      if (!chatRepo && config.gateway?.chatsDbPath) {
        chatRepo = initDb(resolve(process.cwd(), config.gateway.chatsDbPath));
      }
      if (!chatRepo) {
        res.writeHead(503, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Chats DB not configured (gateway.chatsDbPath)" }));
        return;
      }
      try {
        const body = await parseBody(req);
        const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const sessionId = typeof data.session_id === "string" ? data.session_id.trim() : "";
        if (!sessionId) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "session_id required" }));
          return;
        }
        const title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : null;
        const upToCount =
          typeof data.up_to_count === "number" && Number.isFinite(data.up_to_count)
            ? Math.max(0, Math.floor(data.up_to_count))
            : undefined;
        const newSessionId = generateSessionId();
        const newId = chatRepo.duplicateChat(userId, sessionId, newSessionId, {
          title,
          upToCount,
        });
        if (!newId) {
          res.writeHead(404, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Chat not found" }));
          return;
        }
        const chat = chatRepo.listChats(userId).find((c) => c.id === newId) ?? null;
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ sessionId: newId, chat }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (req.method === "DELETE" && p === "/chat") {
      const deleteUrl = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
      const sessionId = deleteUrl.searchParams.get("session_id")?.trim();
      if (!sessionId) {
        res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "session_id required" }));
        return;
      }
      let chatRepo = getChatRepository();
      if (!chatRepo && config.gateway?.chatsDbPath) {
        chatRepo = initDb(resolve(process.cwd(), config.gateway.chatsDbPath));
      }
      if (!chatRepo) {
        res.writeHead(503, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Chats DB not configured (gateway.chatsDbPath)" }));
        return;
      }
      try {
        // Stop the turn and let it store what it did before its chat disappears.
        const running = abortChatRun(sessionId, "Chat deleted");
        if (running) await waitForChatRun(running, config.gateway?.chatRunSettleWaitMs ?? DEFAULT_CHAT_RUN_SETTLE_WAIT_MS);
        const deleted = chatRepo.deleteChat(sessionId, userId);
        if (deleted) releaseSessionRuntime(sessionId);
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ ok: deleted }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (req.method === "DELETE" && p === "/project") {
      const deleteUrl = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
      const projectId = deleteUrl.searchParams.get("project_id")?.trim();
      if (!projectId) {
        res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "project_id required" }));
        return;
      }
      let chatRepo = getChatRepository();
      if (!chatRepo && config.gateway?.chatsDbPath) {
        chatRepo = initDb(resolve(process.cwd(), config.gateway.chatsDbPath));
      }
      if (!chatRepo) {
        res.writeHead(503, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Chats DB not configured (gateway.chatsDbPath)" }));
        return;
      }
      try {
        const ok = chatRepo.deleteProject(userId, projectId);
        if (!ok) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ ok: false, error: "Project not found or has chats" }));
          return;
        }
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (req.method === "GET" && p === "/project/list") {
      let chatRepo = getChatRepository();
      if (!chatRepo && config.gateway?.chatsDbPath) {
        chatRepo = initDb(resolve(process.cwd(), config.gateway.chatsDbPath));
      }
      if (!chatRepo) {
        res.writeHead(503, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Chats DB not configured (gateway.chatsDbPath)" }));
        return;
      }
      try {
        const projects = chatRepo.listProjects(userId);
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ projects }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (req.method === "POST" && p === "/project") {
      let chatRepo = getChatRepository();
      if (!chatRepo && config.gateway?.chatsDbPath) {
        chatRepo = initDb(resolve(process.cwd(), config.gateway.chatsDbPath));
      }
      if (!chatRepo) {
        res.writeHead(503, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Chats DB not configured (gateway.chatsDbPath)" }));
        return;
      }
      try {
        const body = await parseBody(req);
        const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const name = typeof data.name === "string" ? data.name.trim() : "";
        const description = typeof data.description === "string" ? data.description : "";
        const project = chatRepo.createProject(userId, name || "Project", description);
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify(project));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if ((req.method === "PATCH" || req.method === "PUT") && p === "/project") {
      let chatRepo = getChatRepository();
      if (!chatRepo && config.gateway?.chatsDbPath) {
        chatRepo = initDb(resolve(process.cwd(), config.gateway.chatsDbPath));
      }
      if (!chatRepo) {
        res.writeHead(503, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Chats DB not configured (gateway.chatsDbPath)" }));
        return;
      }
      try {
        const body = await parseBody(req);
        const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const projectId =
          typeof data.project_id === "string"
            ? data.project_id.trim()
            : typeof data.id === "string"
              ? data.id.trim()
              : "";
        if (!projectId) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "project_id required" }));
          return;
        }
        const patch: { name?: string; description?: string } = {};
        if (typeof data.name === "string") patch.name = data.name;
        if (typeof data.description === "string") patch.description = data.description;
        if (patch.name === undefined && patch.description === undefined) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "name or description required" }));
          return;
        }
        const project = chatRepo.updateProject(userId, projectId, patch);
        if (!project) {
          res.writeHead(404, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Project not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify(project));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (req.method === "POST" && p === "/api/agent-selection/rate") {
      try {
        const body = await parseBody(req);
        const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const runId = typeof data.runId === "number" ? data.runId : Number(data.runId);
        const rating = typeof data.rating === "number" ? data.rating : Number(data.rating);
        if (!Number.isInteger(runId) || runId < 1 || (rating !== 0 && rating !== 1)) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "runId (positive integer) and rating (0 or 1) required" }));
          return;
        }
        const updated = updateRunRating(config, runId, rating);
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify(updated ? { ok: true } : { ok: false, error: "run not found" }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (req.method === "GET" && p === "/health") {
      const accept = String(req.headers.accept || "");
      let wantJson = accept.includes("application/json");
      try {
        const healthUrl = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
        wantJson = wantJson || healthUrl.searchParams.get("format") === "json";
      } catch {
        /* ignore */
      }
      if (wantJson) {
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(
          JSON.stringify({
            ok: true,
            app: "claw2",
            desktop: process.env.CLAW2_DESKTOP === "1",
            pid: process.pid,
          })
        );
      } else {
        res.writeHead(200, { "Content-Type": TEXT_TYPE });
        res.end("ok");
      }
      return;
    }
    if (req.method === "POST" && p === "/api/chat/export-claw-cache") {
      try {
        const body = await parseBody(req);
        const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const sessionId = typeof data.sessionId === "string" ? data.sessionId.trim() : "";
        if (!sessionId) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "sessionId required" }));
          return;
        }
        let chatRepo = getChatRepository();
        if (!chatRepo && config.gateway?.chatsDbPath) {
          chatRepo = initDb(resolve(process.cwd(), config.gateway.chatsDbPath));
        }
        let effectiveConfig: Claw2Config = config;
        if (isRegistrationMode(config) && userId !== "default") {
          const repo = getAuthRepo(config);
          const userConfig = await getCachedUserConfig(repo, userId);
          effectiveConfig = getEffectiveConfig(config, userConfig);
        }
        const messages = chatRepo
          ? chatRepo.getMessages(sessionId, userId)
          : getSessionHistory(sessionId);
        if (messages.length < 2) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Session has fewer than 2 messages" }));
          return;
        }
        const exported = await exportSessionToClawCacheBuffer({
          messages,
          sessionId,
          cacheId: typeof data.cache_id === "string" ? data.cache_id.trim() : undefined,
          name: typeof data.name === "string" ? data.name.trim() : undefined,
          description: typeof data.description === "string" ? data.description.trim() : undefined,
          domain: typeof data.domain === "string" ? data.domain.trim() : undefined,
          language: typeof data.language === "string" ? data.language.trim() : undefined,
          generatorModel:
            typeof data.generator_model === "string"
              ? data.generator_model.trim()
              : effectiveConfig.llm?.model,
          author: typeof data.author === "string" ? data.author.trim() : userLogin || userId,
        });
        const saveToStore = data.save === true;
        if (saveToStore) {
          const storePath = effectiveConfig.orchestrator?.cacheStorePath?.trim();
          if (!storePath) {
            res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
            res.end(JSON.stringify({ error: "orchestrator.cacheStorePath not configured" }));
            return;
          }
          const dir = resolve(storePath);
          mkdirSync(dir, { recursive: true });
          const outPath = join(dir, exported.filename);
          writeFileSync(outPath, exported.buffer);
          res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(
            JSON.stringify({
              ok: true,
              saved: true,
              path: outPath,
              cacheId: exported.cacheId,
              turnCount: exported.turnCount,
              filename: exported.filename,
              warnings: exported.warnings,
            })
          );
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": contentDispositionAttachment(exported.filename),
          "Access-Control-Allow-Origin": corsOrigin,
          "X-Claw-Cache-Id": exported.cacheId.replace(/[^\x20-\x7E]/g, "_"),
          "X-Claw-Cache-Turns": String(exported.turnCount),
          "X-Claw-Cache-Scan": exported.warnings.length === 0 ? "passed" : "flagged",
        });
        res.end(exported.buffer);
      } catch (err) {
        console.error("[gateway] export-claw-cache error:", err);
        const message = err instanceof Error ? err.message : String(err);
        const status = /недостаточно реплик|fewer than 2/i.test(message) ? 400 : 500;
        res.writeHead(status, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }
    if (req.method === "GET" && p === "/api/catalog/caches") {
      try {
        if (isRegistrationMode(config) && userId === "default") {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
          return;
        }
        let effectiveConfig: Claw2Config = config;
        if (isRegistrationMode(config) && userId !== "default") {
          const repo = getAuthRepo(config);
          const userConfig = await getCachedUserConfig(repo, userId);
          effectiveConfig = getEffectiveConfig(config, userConfig);
        }
        const storePath = effectiveConfig.orchestrator?.cacheStorePath;
        const [caches, quarantined] = await Promise.all([
          listCachesFromDir(storePath),
          listQuarantinedCaches(storePath),
        ]);
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ caches, quarantined }));
      } catch (err) {
        console.error("[gateway] catalog/caches error:", err);
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (req.method === "POST" && p === "/api/catalog/caches/import") {
      try {
        if (isRegistrationMode(config) && userId === "default") {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
          return;
        }
        let effectiveConfig: Claw2Config = config;
        if (isRegistrationMode(config) && userId !== "default") {
          const repo = getAuthRepo(config);
          const userConfig = await getCachedUserConfig(repo, userId);
          effectiveConfig = getEffectiveConfig(config, userConfig);
        }
        const storePath = effectiveConfig.orchestrator?.cacheStorePath?.trim();
        if (!storePath) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "orchestrator.cacheStorePath not configured" }));
          return;
        }
        const body = await parseBody(req);
        const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const sourcePath = typeof data.sourcePath === "string" ? data.sourcePath.trim() : "";
        if (!sourcePath) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "sourcePath required" }));
          return;
        }
        const item = await importCacheIntoStore(storePath, sourcePath);
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ ok: true, cache: item.cache, quarantined: true, scan: item.scan }));
      } catch (err) {
        console.error("[gateway] catalog/caches/import error:", err);
        res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }
    if (req.method === "POST" && p === "/api/catalog/caches/accept") {
      try {
        if (isRegistrationMode(config) && userId === "default") {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
          return;
        }
        let effectiveConfig: Claw2Config = config;
        if (isRegistrationMode(config) && userId !== "default") {
          const repo = getAuthRepo(config);
          const userConfig = await getCachedUserConfig(repo, userId);
          effectiveConfig = getEffectiveConfig(config, userConfig);
        }
        const storePath = effectiveConfig.orchestrator?.cacheStorePath?.trim();
        if (!storePath) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "orchestrator.cacheStorePath not configured" }));
          return;
        }
        const body = await parseBody(req);
        const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const fileName = typeof data.file_name === "string" ? data.file_name.trim() : "";
        if (!fileName) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "file_name required" }));
          return;
        }
        const result = await acceptQuarantinedCache(storePath, fileName);
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ ok: true, cache: result.cache }));
      } catch (err) {
        console.error("[gateway] catalog/caches/accept error:", err);
        res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }
    if (req.method === "PATCH" && p === "/api/catalog/caches") {
      try {
        if (isRegistrationMode(config) && userId === "default") {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
          return;
        }
        let effectiveConfig: Claw2Config = config;
        if (isRegistrationMode(config) && userId !== "default") {
          const repo = getAuthRepo(config);
          const userConfig = await getCachedUserConfig(repo, userId);
          effectiveConfig = getEffectiveConfig(config, userConfig);
        }
        const storePath = effectiveConfig.orchestrator?.cacheStorePath?.trim();
        if (!storePath) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "orchestrator.cacheStorePath not configured" }));
          return;
        }
        const body = await parseBody(req);
        const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const fileName = typeof data.file_name === "string" ? data.file_name.trim() : "";
        const name = typeof data.name === "string" ? data.name.trim() : "";
        if (!fileName || !name) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "file_name and name required" }));
          return;
        }
        const item = await renameCacheDisplayName(storePath, fileName, name);
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ ok: true, cache: item }));
      } catch (err) {
        console.error("[gateway] catalog/caches PATCH error:", err);
        res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }
    if (req.method === "DELETE" && p === "/api/catalog/caches") {
      try {
        if (isRegistrationMode(config) && userId === "default") {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
          return;
        }
        let effectiveConfig: Claw2Config = config;
        if (isRegistrationMode(config) && userId !== "default") {
          const repo = getAuthRepo(config);
          const userConfig = await getCachedUserConfig(repo, userId);
          effectiveConfig = getEffectiveConfig(config, userConfig);
        }
        const storePath = effectiveConfig.orchestrator?.cacheStorePath?.trim();
        if (!storePath) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "orchestrator.cacheStorePath not configured" }));
          return;
        }
        const body = await parseBody(req);
        const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const fileName = typeof data.file_name === "string" ? data.file_name.trim() : "";
        if (!fileName) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "file_name required" }));
          return;
        }
        await deleteCacheFile(storePath, fileName);
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error("[gateway] catalog/caches DELETE error:", err);
        res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    async function resolveWritableConfigContext(): Promise<{
      effective: Claw2Config;
      repo: AuthRepository | null;
      baseRecord: Record<string, unknown>;
    } | null> {
      if (isRegistrationMode(config) && userId === "default") return null;
      const repo = isRegistrationMode(config) && userId !== "default" ? getAuthRepo(config) : null;
      if (repo) {
        const userConfig = await getCachedUserConfig(repo, userId);
        const effective = getEffectiveConfig(config, userConfig);
        const baseRecord =
          userConfig != null && typeof userConfig === "object" && Object.keys(userConfig).length > 0
            ? (userConfig as Record<string, unknown>)
            : (config as unknown as Record<string, unknown>);
        return { effective, repo, baseRecord };
      }
      return {
        effective: config,
        repo: null,
        baseRecord: config as unknown as Record<string, unknown>,
      };
    }

    async function persistConfigPatch(patch: Record<string, unknown>): Promise<{ ok: true; source: "db" | "file" } | { ok: false; error: string }> {
      const ctx = await resolveWritableConfigContext();
      if (!ctx) return { ok: false, error: "Unauthorized" };
      if (ctx.repo) {
        const merged = mergeConfigKeepingSecrets(ctx.baseRecord, { ...ctx.baseRecord, ...patch });
        // deep-ish: for disabledAgents/skills replace keys from patch
        for (const [k, v] of Object.entries(patch)) {
          (merged as Record<string, unknown>)[k] = v;
        }
        await ctx.repo.setUserConfig(userId, merged);
        invalidateUserConfigCache(userId);
        auditLog(config, { type: "config_saved", details: { source: "db", userId, patch: Object.keys(patch) } });
        return { ok: true, source: "db" };
      }
      const configPath = getConfigPath();
      let data: Record<string, unknown> = { ...ctx.baseRecord, ...patch };
      if (existsSync(configPath)) {
        try {
          const existing = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
          data = mergeConfigKeepingSecrets(existing, { ...existing, ...patch });
          for (const [k, v] of Object.entries(patch)) {
            (data as Record<string, unknown>)[k] = v;
          }
        } catch {
          // use patch merge only
        }
      }
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, stringifyYaml(data), "utf-8");
      const reloaded = loadConfig(configPath);
      configRef.current = reloaded;
      resetMemoryStore();
      auditLog(reloaded, { type: "config_saved", details: { configPath, patch: Object.keys(patch) } });
      return { ok: true, source: "file" };
    }

    if (req.method === "GET" && p === "/api/agents") {
      try {
        const ctx = await resolveWritableConfigContext();
        if (!ctx) {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
          return;
        }
        const agents = listAgentsWithStatus(ctx.effective);
        const skillsAllowlist = Array.isArray(ctx.effective.skills?.allowlist)
          ? ctx.effective.skills!.allowlist!
          : [];
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ agents, skillsAllowlist, disabledAgents: normalizeDisabledAgents(ctx.effective.disabledAgents) }));
      } catch (err) {
        console.error("[gateway] agents list error:", err);
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "POST" && p === "/api/agents") {
      try {
        // Writing executable skill code is an operator decision in hosted mode
        // (same policy as /allow): an ordinary tenant must not be able to mint
        // skills, whatever the allowlist default is.
        if (isRegistrationIntended(config) && !isRegistrationAdmin(config, userLogin)) {
          res.writeHead(403, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Forbidden: skill authoring requires gateway.auth.admins" }));
          return;
        }
        const ctx = await resolveWritableConfigContext();
        if (!ctx) {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
          return;
        }
        const body = await parseBody(req);
        const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const name = String(data.name ?? data.script ?? "");
        const description = typeof data.description === "string" ? data.description : undefined;
        const content = typeof data.content === "string" ? data.content : undefined;
        const result = createAgentStub(ctx.effective, name, description, content);
        if (!result.ok) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: result.message }));
          return;
        }
        auditLog(ctx.effective, { type: "agent_created", details: { name: result.name } });
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ ok: true, name: result.name, message: result.message }));
      } catch (err) {
        console.error("[gateway] agents create error:", err);
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "PATCH" && p === "/api/agents") {
      try {
        const ctx = await resolveWritableConfigContext();
        if (!ctx) {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
          return;
        }
        const body = await parseBody(req);
        const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const name = String(data.name ?? data.script ?? "");
        if (typeof data.enabled !== "boolean") {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "enabled boolean required" }));
          return;
        }
        if (!safeScriptName(name)) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Invalid agent name" }));
          return;
        }
        const nextDisabled = setAgentEnabledInList(ctx.effective.disabledAgents ?? [], name, data.enabled);
        const saved = await persistConfigPatch({ disabledAgents: nextDisabled });
        if (!saved.ok) {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: saved.error }));
          return;
        }
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ ok: true, name: safeScriptName(name), enabled: data.enabled, disabledAgents: nextDisabled, _source: saved.source }));
      } catch (err) {
        console.error("[gateway] agents patch error:", err);
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "DELETE" && p === "/api/agents") {
      try {
        const ctx = await resolveWritableConfigContext();
        if (!ctx) {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
          return;
        }
        const deleteUrl = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
        const name = deleteUrl.searchParams.get("name")?.trim() || "";
        const result = deleteAgent(ctx.effective, name);
        if (!result.ok) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: result.message }));
          return;
        }
        // remove from disabled list if present
        const nextDisabled = setAgentEnabledInList(ctx.effective.disabledAgents ?? [], name, true);
        if (nextDisabled.length !== normalizeDisabledAgents(ctx.effective.disabledAgents).length) {
          await persistConfigPatch({ disabledAgents: nextDisabled });
        }
        auditLog(ctx.effective, { type: "agent_deleted", details: { name } });
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ ok: true, message: result.message }));
      } catch (err) {
        console.error("[gateway] agents delete error:", err);
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "PUT" && p === "/api/skills") {
      try {
        const body = await parseBody(req);
        const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const rawList = Array.isArray(data.allowlist) ? data.allowlist : null;
        if (!rawList) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "allowlist array required" }));
          return;
        }
        const allowlist = [...new Set(rawList.map((s) => String(s ?? "").trim()).filter(Boolean))];
        const saved = await persistConfigPatch({ skills: { allowlist } });
        if (!saved.ok) {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: saved.error }));
          return;
        }
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ ok: true, allowlist, _source: saved.source }));
      } catch (err) {
        console.error("[gateway] skills put error:", err);
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "GET" && p === "/api/privacy/sidecar-status") {
      try {
        if (isRegistrationMode(config) && userId === "default") {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
          return;
        }
        let effectiveConfig: Claw2Config = config;
        if (isRegistrationMode(config) && userId !== "default") {
          const repo = getAuthRepo(config);
          const userConfig = await getCachedUserConfig(repo, userId);
          effectiveConfig = getEffectiveConfig(config, userConfig);
        }
        const backend = resolveMultimodalBackend(effectiveConfig);
        const pathFound = findPrivacyOcrSidecarBinary(effectiveConfig) ?? null;
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(
          JSON.stringify({
            found: !!pathFound,
            path: pathFound,
            multimodalBackend: backend.requested,
            useSidecar: backend.useSidecar,
            reason: backend.reason,
          })
        );
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (req.method === "POST" && p === "/api/privacy/mask-preview") {
      try {
        if (isRegistrationMode(config) && userId === "default") {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
          return;
        }
        const body = await parseBody(req);
        const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const text = typeof data.text === "string" ? data.text : "";
        let effectiveConfig: Claw2Config = config;
        if (isRegistrationMode(config) && userId !== "default") {
          const repo = getAuthRepo(config);
          const userConfig = await getCachedUserConfig(repo, userId);
          effectiveConfig = getEffectiveConfig(config, userConfig);
        }
        const rulesOverride = Array.isArray(data.customRules)
          ? (data.customRules as PrivacyCustomRule[])
          : effectiveConfig.privacy?.customRules;
        const masker = new PiiMasker(rulesOverride);
        const masked = masker.maskText(text);
        const decision = shouldApplyPrivacy({
          ...effectiveConfig,
          privacy: {
            ...effectiveConfig.privacy,
            enabled: data.enabled === true ? true : effectiveConfig.privacy?.enabled,
            applyToLocal:
              data.applyToLocal === true ? true : effectiveConfig.privacy?.applyToLocal,
            customRules: rulesOverride,
          },
        });
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(
          JSON.stringify({
            masked,
            tokenCount: masker.tokenCount,
            wouldApply: decision.apply,
            reason: decision.reason,
            localEndpoint: decision.localEndpoint,
          })
        );
        masker.clear();
      } catch (err) {
        res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (req.method === "POST" && p === "/api/chat/browser-page-text") {
      try {
        if (isRegistrationMode(config) && userId === "default") {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
          return;
        }
        const body = await parseBody(req);
        const data = body
          ? (JSON.parse(body) as {
              requestId?: string;
              url?: string;
              title?: string;
              text?: string;
              truncated?: boolean;
            })
          : {};
        const requestId = typeof data.requestId === "string" ? data.requestId.trim() : "";
        if (!requestId) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ ok: false, error: "requestId required" }));
          return;
        }
        const text = typeof data.text === "string" ? data.text.slice(0, 16_000) : "";
        const ok = resolveBrowserPageText(requestId, {
          text,
          url: typeof data.url === "string" ? data.url.trim() : undefined,
          title: typeof data.title === "string" ? data.title.trim() : undefined,
          truncated: data.truncated === true,
        });
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ ok }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (req.method === "POST" && p === "/api/browser/search") {
      try {
        if (isRegistrationMode(config) && userId === "default") {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
          return;
        }
        const body = await parseBody(req);
        const data = body ? (JSON.parse(body) as { query?: string }) : {};
        const query = typeof data.query === "string" ? data.query.trim() : "";
        if (!query) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ ok: false, error: "query required" }));
          return;
        }
        let effectiveConfig: Claw2Config = config;
        if (isRegistrationMode(config) && userId !== "default") {
          const repo = getAuthRepo(config);
          const userConfig = await getCachedUserConfig(repo, userId);
          effectiveConfig = getEffectiveConfig(config, userConfig);
        }
        const result = await toolSearch(effectiveConfig, query);
        if (!result.ok) {
          res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(
            JSON.stringify({
              ok: false,
              error: result.error,
              provider: result.provider,
            })
          );
          return;
        }
        const hits = (result.hits ?? []).map((h) => ({
          title: h.title ?? "",
          url: h.url ?? "",
          snippet: h.description ?? h.content ?? "",
        }));
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(
          JSON.stringify({
            ok: true,
            provider: result.provider,
            hits,
            markdown: formatSearchHitsMarkdown(result.hits ?? [], query),
          })
        );
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (req.method === "GET" && p === "/api/config") {
      try {
        // In registration mode, the config is only from the database; We do not give away the file without authorization.
        if (isRegistrationMode(config) && userId === "default") {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
          return;
        }
        const repo = isRegistrationMode(config) && userId !== "default" ? getAuthRepo(config) : null;
        let payload: Record<string, unknown>;
        let source: "db" | "file" = "file";
        if (repo) {
          const userConfig = await repo.getUserConfig(userId);
          const hasUserConfig =
            userConfig != null &&
            typeof userConfig === "object" &&
            Object.keys(userConfig).length > 0;
          if (hasUserConfig) {
            // Same policy filter as the effective config: the settings UI must
            // not round-trip admin-owned keys even if an old DB row has them.
            payload = maskSecrets(applyUserConfigPolicy(userConfig) ?? {}) as Record<string, unknown>;
            source = "db";
          } else {
            // There is no config in the database - we give the file one as a template to be filled in in the settings.
            // RAW form (loadConfigRaw): the UI edits and stores the operator's
            // portable 127.0.0.1 form; loopback→host.docker.internal mapping
            // happens only in loadConfig for runtime consumers.
            // Hosted mode: the tenant template is policy-filtered too — the
            // operator's file config must not leak sandbox/channel topology.
            payload = maskSecrets(
              applyUserConfigPolicy(loadConfigRaw(getConfigPath()) as Record<string, unknown>) ?? {}
            ) as Record<string, unknown>;
            source = "file";
          }
        } else {
          payload = maskSecrets(loadConfigRaw(getConfigPath())) as Record<string, unknown>;
        }
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ ...payload, _source: source }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (req.method === "PUT" && p === "/api/config") {
      try {
        if (isRegistrationMode(config) && userId === "default") {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
          return;
        }
        const body = await parseBody(req);
        let data: Record<string, unknown> = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const { _source: _drop, ...dataWithoutMeta } = data;
        data = Object.keys(dataWithoutMeta).length ? dataWithoutMeta : data;

        const repo = isRegistrationMode(config) && userId !== "default" ? getAuthRepo(config) : null;
        if (repo) {
          const existing = await repo.getUserConfig(userId);
          const baseForMerge =
            existing != null && typeof existing === "object" && Object.keys(existing).length > 0
              ? (existing as Record<string, unknown>)
              : (config as unknown as Record<string, unknown>);
          // Security policy: drop admin-owned keys from the incoming patch AND
          // from the merged result (stale DB rows must not survive either).
          const merged = applyUserConfigPolicy(
            mergeConfigKeepingSecrets(baseForMerge, data as Record<string, unknown>)
          ) as Record<string, unknown>;
          await repo.setUserConfig(userId, merged);
          invalidateUserConfigCache(userId);
          auditLog(config, { type: "config_saved", details: { source: "db", userId } });
          console.error(`[gateway] Config saved to DB for user ${userId}`);
          res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(
            JSON.stringify({
              ok: true,
              message: "Settings saved to your account.",
              _source: "db",
            })
          );
          return;
        }

        const configPath = getConfigPath();
        if (existsSync(configPath)) {
          try {
            const existing = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
            data = mergeConfigKeepingSecrets(existing, data);
          } catch {
            // use only incoming if merge fails
          }
        }
        mkdirSync(dirname(configPath), { recursive: true });
        const yamlContent = stringifyYaml(data);
        writeFileSync(configPath, yamlContent, "utf-8");
        const reloaded = loadConfig(configPath);
        configRef.current = reloaded;
        resetMemoryStore();
        auditLog(reloaded, { type: "config_saved", details: { configPath } });
        console.error(`[gateway] Config saved to ${configPath}`);
        void syncSipClient(reloaded).catch((err) =>
          console.error("[gateway] SIP sync after config save:", err)
        );
        try {
          syncRemoteAccess(() => configRef.current);
        } catch (err) {
          console.error("[gateway] remote-access sync after config save:", err);
        }
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(
          JSON.stringify({
            ok: true,
            message: "Config saved and applied.",
            configPath,
            _source: "file",
          })
        );
      } catch (err) {
        console.error("[gateway] Config save failed:", err);
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "GET" && p === "/api/remote-access/status") {
      try {
        if (isRegistrationMode(config) && userId === "default") {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
          return;
        }
        const status = getRemoteAccessPublicStatus(configRef.current);
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify(status));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "POST" && p === "/api/remote-access/ddns/update") {
      if (isRegistrationIntended(config) && !isRegistrationAdmin(config, userLogin)) {
        res.writeHead(403, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Forbidden: operator action requires gateway.auth.admins" }));
        return;
      }
      try {
        if (isRegistrationMode(config) && userId === "default") {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
          return;
        }
        const result = await runDdnsUpdate(configRef.current);
        res.writeHead(result.ok ? 200 : 400, {
          "Content-Type": JSON_TYPE,
          "Access-Control-Allow-Origin": corsOrigin,
        });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "POST" && p === "/api/remote-access/cert/issue") {
      if (isRegistrationIntended(config) && !isRegistrationAdmin(config, userLogin)) {
        res.writeHead(403, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Forbidden: operator action requires gateway.auth.admins" }));
        return;
      }
      try {
        if (isRegistrationMode(config) && userId === "default") {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
          return;
        }
        const result = await runCertIssue(configRef.current);
        res.writeHead(result.ok ? 200 : 400, {
          "Content-Type": JSON_TYPE,
          "Access-Control-Allow-Origin": corsOrigin,
        });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "POST" && p === "/api/remote-access/https/open") {
      if (isRegistrationIntended(config) && !isRegistrationAdmin(config, userLogin)) {
        res.writeHead(403, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Forbidden: operator action requires gateway.auth.admins" }));
        return;
      }
      try {
        if (isRegistrationMode(config) && userId === "default") {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
          return;
        }
        const result = await runHttpsOpen(configRef.current);
        res.writeHead(result.ok ? 200 : 400, {
          "Content-Type": JSON_TYPE,
          "Access-Control-Allow-Origin": corsOrigin,
        });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "POST" && p === "/api/remote-access/https/close") {
      if (isRegistrationIntended(config) && !isRegistrationAdmin(config, userLogin)) {
        res.writeHead(403, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Forbidden: operator action requires gateway.auth.admins" }));
        return;
      }
      try {
        if (isRegistrationMode(config) && userId === "default") {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
          return;
        }
        const result = await runHttpsClose();
        res.writeHead(result.ok ? 200 : 400, {
          "Content-Type": JSON_TYPE,
          "Access-Control-Allow-Origin": corsOrigin,
        });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "POST" && p === "/api/remote-access/https/on-tray-hide") {
      try {
        if (isRegistrationMode(config) && userId === "default") {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
          return;
        }
        const result = await runHttpsOnTrayHide(configRef.current);
        res.writeHead(result.ok ? 200 : 400, {
          "Content-Type": JSON_TYPE,
          "Access-Control-Allow-Origin": corsOrigin,
        });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "GET" && p === "/api/assistant-persona") {
      try {
        if (isRegistrationMode(config) && userId === "default") {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
          return;
        }
        let effectiveConfig: Claw2Config = config;
        if (isRegistrationMode(config) && userId !== "default") {
          const repo = getAuthRepo(config);
          const userConfig = await getCachedUserConfig(repo, userId);
          effectiveConfig = getEffectiveConfig(config, userConfig);
        }
        const persona = readAssistantPersonaForEdit(effectiveConfig);
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(
          JSON.stringify({
            full: persona.full,
            compact: persona.compact,
            markdown: persona.markdown,
            path: persona.path,
            isDefault: !!persona.isDefault,
          })
        );
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "PUT" && p === "/api/assistant-persona") {
      try {
        if (isRegistrationMode(config) && userId === "default") {
          res.writeHead(401, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Unauthorized", code: "auth_required" }));
          return;
        }
        const body = await parseBody(req);
        const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        let full = typeof data.full === "string" ? data.full : "";
        let compact = typeof data.compact === "string" ? data.compact : "";
        if (typeof data.markdown === "string" && data.markdown.trim()) {
          const parsed = parseAssistantMd(data.markdown);
          full = parsed.full;
          compact = parsed.compact;
        }
        if (!full.trim()) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "full (or markdown) is required" }));
          return;
        }
        const markdown = buildAssistantMarkdown(full, compact);
        const repo = isRegistrationMode(config) && userId !== "default" ? getAuthRepo(config) : null;
        if (repo) {
          const existing = await repo.getUserConfig(userId);
          const base =
            existing != null && typeof existing === "object" && Object.keys(existing).length > 0
              ? (existing as Record<string, unknown>)
              : (config as unknown as Record<string, unknown>);
          const prevAssistant =
            base.assistant && typeof base.assistant === "object" && !Array.isArray(base.assistant)
              ? (base.assistant as Record<string, unknown>)
              : {};
          const merged = {
            ...base,
            assistant: { ...prevAssistant, personaMarkdown: markdown },
          };
          await repo.setUserConfig(userId, merged);
          invalidateUserConfigCache(userId);
          resetAssistantPersonaCache();
          auditLog(config, { type: "config_saved", details: { source: "db", userId, kind: "assistant_persona" } });
          res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ ok: true, full: parseAssistantMd(markdown).full, compact: parseAssistantMd(markdown).compact, source: "db" }));
          return;
        }
        const written = writeAssistantPersonaFile(full, compact, config);
        auditLog(config, { type: "config_saved", details: { path: written.path, kind: "assistant_persona" } });
        const parsed = parseAssistantMd(written.markdown);
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(
          JSON.stringify({
            ok: true,
            full: parsed.full,
            compact: parsed.compact,
            path: written.path,
            source: "file",
          })
        );
      } catch (err) {
        console.error("[gateway] assistant-persona save failed:", err);
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "POST" && p === "/api/restart") {
      if (isRegistrationIntended(config) && !isRegistrationAdmin(config, userLogin)) {
        res.writeHead(403, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Forbidden: operator action requires gateway.auth.admins" }));
        return;
      }
      auditLog(config, { type: "restart_requested" });
      res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => {
        const child = spawn(process.argv[0], process.argv.slice(1), {
          cwd: process.cwd(),
          env: process.env,
          detached: true,
          stdio: "inherit",
        });
        child.unref();
        process.exit(0);
      }, 300);
      return;
    }
    if (req.method === "POST" && p === "/api/notify/telegram") {
      try {
        const body = await parseBody(req);
        const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const text = typeof data.text === "string" ? data.text.trim() : "";
        if (!text) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "body must be { text: string }" }));
          return;
        }
        const result = await sendNotifyToOwner(config, text);
        if (!result.ok) {
          res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: result.error }));
          return;
        }
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (req.method === "GET" && p === "/api/sip/status") {
      try {
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify(getSipClient().getStatus()));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (req.method === "GET" && p === "/api/connections/status") {
      try {
        const repo = isRegistrationMode(config) && userId !== "default" ? getAuthRepo(config) : null;
        let effective = config;
        if (repo) {
          const userConfig = await getCachedUserConfig(repo, userId);
          effective = getEffectiveConfig(config, userConfig);
        }
        const status = await collectConnectionsStatus(effective);
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify(status));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (req.method === "GET" && p === "/api/calls") {
      try {
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ calls: listCallLogs() }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (req.method === "GET" && p === "/api/calls/export.md") {
      try {
        const md = allCallLogsToMarkdown(listCallLogRecords());
        const filename = `call-logs-${new Date().toISOString().slice(0, 10)}.md`;
        res.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Access-Control-Allow-Origin": corsOrigin,
        });
        res.end(md);
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    {
      const callMatch = p.match(/^\/api\/calls\/([^/]+)$/);
      if (req.method === "GET" && callMatch) {
        const id = decodeURIComponent(callMatch[1]);
        const rec = getCallLog(id);
        if (!rec) {
          res.writeHead(404, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Call not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify(rec));
        return;
      }
      const callMdMatch = p.match(/^\/api\/calls\/([^/]+)\/export\.md$/);
      if (req.method === "GET" && callMdMatch) {
        const id = decodeURIComponent(callMdMatch[1]);
        const rec = getCallLog(id);
        if (!rec) {
          res.writeHead(404, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Call not found" }));
          return;
        }
        const md = callLogToMarkdown(rec);
        const safe = id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "call";
        res.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="call-${safe}.md"`,
          "Access-Control-Allow-Origin": corsOrigin,
        });
        res.end(md);
        return;
      }
    }
    if (req.method === "GET" && p === "/api/voice/tts-voices") {
      try {
        const repo = isRegistrationMode(config) && userId !== "default" ? getAuthRepo(config) : null;
        let effective = config;
        if (repo) {
          const userConfig = await getCachedUserConfig(repo, userId);
          effective = getEffectiveConfig(config, userConfig);
        }
        const result = await fetchTtsVoiceOptions(effective);
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(502, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err), voices: [], source: "catalog", current: "" }));
      }
      return;
    }
    if (req.method === "GET" && p === "/api/llm/models") {
      try {
        const repo = isRegistrationMode(config) && userId !== "default" ? getAuthRepo(config) : null;
        let effective = config;
        if (repo) {
          const userConfig = await getCachedUserConfig(repo, userId);
          effective = getEffectiveConfig(config, userConfig);
        }
        const tenantEndpointError = await assertTenantLlmEndpointPublic(config, userId, effective);
        if (tenantEndpointError) {
          res.writeHead(403, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: tenantEndpointError, code: "endpoint_not_allowed", models: [] }));
          return;
        }
        const llm = effective.llm;
        const baseURL = (llm?.baseURL?.trim() || process.env.OPENAI_BASE_URL?.trim() || "").replace(/\/+$/, "");
        // resolveLlmApiKey honors the tenant guard (noOperatorApiKeyFallback):
        // a user-pointed provider never receives the operator's env key here.
        const apiKey = resolveLlmApiKey(effective);
        if (!baseURL) {
          res.writeHead(503, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "LLM baseURL not configured", models: [], current: llm?.model ?? "" }));
          return;
        }
        const modelsUrl = /\/v1$/i.test(baseURL) ? `${baseURL}/models` : `${baseURL}/v1/models`;
        const headers: Record<string, string> = {};
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        const upstream = await fetch(modelsUrl, {
          headers,
          signal: AbortSignal.timeout(20_000),
        });
        const rawText = await upstream.text();
        if (!upstream.ok) {
          res.writeHead(502, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(
            JSON.stringify({
              error: rawText.slice(0, 300) || `HTTP ${upstream.status}`,
              models: [],
              current: llm?.model ?? "",
            }),
          );
          return;
        }
        let parsed: { data?: Array<{ id?: string }> } = {};
        try {
          parsed = JSON.parse(rawText) as typeof parsed;
        } catch {
          res.writeHead(502, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Invalid models response", models: [], current: llm?.model ?? "" }));
          return;
        }
        const NON_CHAT =
          /whisper|tts[-_]|dall-e|dalle|stable-diffusion|flux|midjourney|imagen|embedding|bge-|e5-|assembly|transcri|sora|veo-|txt2img|sdxl|gpt-image|gemini-.*image|z-image/i;
        const ids = (parsed.data ?? [])
          .map((m) => (typeof m.id === "string" ? m.id.trim() : ""))
          .filter((id) => id && !NON_CHAT.test(id));
        ids.sort((a, b) => a.localeCompare(b));
        const current = typeof llm?.model === "string" ? llm.model.trim() : "";
        if (current && !ids.includes(current)) ids.unshift(current);
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ models: ids, current }));
      } catch (err) {
        res.writeHead(502, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err), models: [], current: "" }));
      }
      return;
    }
    if (req.method === "GET" && p === "/api/voice/capabilities") {
      const ttsUrl = resolveVoiceTtsUrl(config);
      const requested = resolveTtsEngine(config);
      let cudaAvailable = false;
      if (ttsUrl && resolveTtsLocal(config)) {
        const healthUrl = ttsUrl.replace(/\/tts\/?$/i, "") + "/health";
        try {
          const upstream = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
          if (upstream.ok) {
            const data = (await upstream.json()) as { cudaAvailable?: boolean };
            cudaAvailable = data.cudaAvailable === true;
          }
        } catch {
          cudaAvailable = false;
        }
      }
      const effectiveEngine = resolveEffectiveTtsEngine(config, cudaAvailable);
      res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
      res.end(
        JSON.stringify({
          cudaAvailable,
          mossAvailable: cudaAvailable,
          mossRequiresCuda: true,
          requestedEngine: requested,
          effectiveEngine,
          sttLocal: resolveSttLocal(config),
          ttsLocal: resolveTtsLocal(config),
        }),
      );
      return;
    }
    if (req.method === "POST" && p === "/api/voice/stt") {
      const sttUrl = resolveVoiceSttUrl(config);
      if (!sttUrl) {
        res.writeHead(503, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Voice (STT) not configured" }));
        return;
      }
      const sttLocal = resolveSttLocal(config);
      if (sttLocal) {
        const lazyUrl = process.env.CLAW2_LAZY_URL?.trim();
        if (lazyUrl) {
          try {
            await fetch(`${lazyUrl.replace(/\/+$/, "")}/wake/voice`, { method: "POST" });
          } catch {
            // continue even if wake fails (the container may already be running)
          }
        }
      }
      try {
        const body = await parseRawBody(req, STT_BODY_LIMIT_BYTES);
        const contentType = req.headers["content-type"] ?? "application/octet-stream";
        console.error(`[voice/stt] local=${sttLocal} bytes=${body.length} ct=${contentType.slice(0, 60)}`);
        if (sttLocal) {
          const upstream = await fetch(sttUrl, {
            method: "POST",
            headers: { "Content-Type": contentType },
            body: new Uint8Array(body),
          });
          const json = await upstream.text();
          res.writeHead(upstream.status, {
            "Content-Type": JSON_TYPE,
            "Access-Control-Allow-Origin": corsOrigin,
          });
          res.end(upstream.ok ? json : JSON.stringify({ error: json || `HTTP ${upstream.status}` }));
        } else {
          const apiKey = resolveSttApiKey(config);
          const model = resolveSttModel(config);
          if (!apiKey) {
            res.writeHead(503, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
            res.end(JSON.stringify({ error: "Voice STT API key not configured (voice.sttApiKey)" }));
            return;
          }
          const inbound = new Response(new Uint8Array(body), {
            headers: { "Content-Type": contentType },
          });
          const incoming = await inbound.formData();
          const filePart = incoming.get("file");
          if (!(filePart instanceof Blob)) {
            res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
            res.end(JSON.stringify({ error: "STT: multipart field 'file' required" }));
            return;
          }
          const out = new FormData();
          const filename =
            filePart instanceof File && filePart.name ? filePart.name : "audio.webm";
          out.append("file", filePart, filename);
          out.append("model", model);
          const endpoint = `${openaiAudioBase(sttUrl)}/audio/transcriptions`;
          const upstream = await fetch(endpoint, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
            body: out,
          });
          const json = await upstream.text();
          console.error(
            `[voice/stt] upstream ${upstream.status} model=${model} file=${filename} bytes=${filePart.size} body=${json.slice(0, 160).replace(/\s+/g, " ")}`,
          );
          res.writeHead(upstream.status, {
            "Content-Type": JSON_TYPE,
            "Access-Control-Allow-Origin": corsOrigin,
          });
          res.end(upstream.ok ? json : JSON.stringify({ error: json || `HTTP ${upstream.status}` }));
        }
      } catch (err) {
        const msg = err instanceof Error && err.cause instanceof Error
          ? `${err.message}: ${(err.cause as Error).message}`
          : String(err);
        res.writeHead(502, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({
          error: msg.includes("fetch failed") || msg.includes("ECONNREFUSED")
            ? `Voice service unreachable (${msg}). Ensure the voice container is running and connected to the claw2 network.`
            : msg,
        }));
      }
      return;
    }
    if (req.method === "POST" && p === "/api/voice/tts") {
      const ttsUrl = resolveVoiceTtsUrl(config);
      if (!ttsUrl) {
        res.writeHead(503, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Voice (TTS) not configured" }));
        return;
      }
      const ttsLocal = resolveTtsLocal(config);
      if (ttsLocal) {
        const lazyUrlTts = process.env.CLAW2_LAZY_URL?.trim();
        if (lazyUrlTts) {
          try {
            await fetch(`${lazyUrlTts.replace(/\/+$/, "")}/wake/voice`, { method: "POST" });
          } catch {
            // continue even if wake fails
          }
        }
      }
      try {
        const body = await parseBody(req);
        const data = body ? (JSON.parse(body) as { text?: string; engine?: string }) : {};
        const text = typeof data.text === "string" ? data.text : "";
        if (ttsLocal) {
          const engine =
            (typeof data.engine === "string" && data.engine.trim()) || resolveTtsEngine(config);
          const upstream = await fetch(ttsUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, engine }),
          });
          if (upstream.status === 204) {
            res.writeHead(204, { "Access-Control-Allow-Origin": corsOrigin });
            res.end();
            return;
          }
          if (!upstream.ok) {
            res.writeHead(502, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
            res.end(JSON.stringify({ error: (await upstream.text()) || `HTTP ${upstream.status}` }));
            return;
          }
          const buf = await upstream.arrayBuffer();
          res.writeHead(200, {
            "Content-Type": "audio/wav",
            "Access-Control-Allow-Origin": corsOrigin,
          });
          res.end(Buffer.from(buf));
        } else {
          const apiKey = resolveTtsApiKey(config);
          const model = resolveTtsModel(config);
          const voiceName = resolveTtsVoice(config);
          if (!apiKey) {
            res.writeHead(503, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
            res.end(JSON.stringify({ error: "Voice TTS API key not configured (voice.ttsApiKey)" }));
            return;
          }
          if (!text.trim()) {
            res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
            res.end(JSON.stringify({ error: "TTS: empty text" }));
            return;
          }
          const endpoint = `${openaiAudioBase(ttsUrl)}/audio/speech`;
          const upstream = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              input: text,
              voice: voiceName,
              response_format: "wav",
            }),
          });
          if (!upstream.ok) {
            res.writeHead(502, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
            res.end(JSON.stringify({ error: (await upstream.text()) || `HTTP ${upstream.status}` }));
            return;
          }
          const buf = await upstream.arrayBuffer();
          const ct = upstream.headers.get("content-type") || "audio/wav";
          res.writeHead(200, {
            "Content-Type": ct,
            "Access-Control-Allow-Origin": corsOrigin,
          });
          res.end(Buffer.from(buf));
        }
      } catch (err) {
        const msg = err instanceof Error && err.cause instanceof Error
          ? `${err.message}: ${(err.cause as Error).message}`
          : String(err);
        res.writeHead(502, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({
          error: msg.includes("fetch failed") || msg.includes("ECONNREFUSED")
            ? `Voice service unreachable (${msg}). Ensure the voice container is running and connected to the claw2 network.`
            : msg,
        }));
      }
      return;
    }
    if (req.method === "GET" && p === "/chat/session-files") {
      const sessionId = typeof req.url === "string" ? new URL(req.url, "http://localhost").searchParams.get("sessionId") ?? "" : "";
      const uploads: { path: string; name: string }[] = [];
      const output: { path: string; name: string }[] = [];
      // Hosted mode: this endpoint lists disk files by name prefix, which leaks
      // other tenants' session ids / outputs. Scope it to sessions the caller
      // owns. Single-key mode keeps the original behavior (one owner anyway).
      if (isRegistrationIntended(config)) {
        const chatRepo = getChatRepository();
        const ownedPrefixes = chatRepo
          ? chatRepo
              .listChats(userId)
              .filter((c) => !sessionId.trim() || c.id === sessionId.trim())
              .map((c) => `${c.id}-`)
          : [];
        if (ownedPrefixes.length > 0) {
          if (existsSync(uploadsDir)) {
            try {
              const names = readdirSync(uploadsDir);
              for (const name of names) {
                if (!ownedPrefixes.some((prefix) => name.startsWith(prefix))) continue;
                uploads.push({ path: `uploads/${name}`, name });
              }
            } catch {
              // ignore
            }
          }
          if (existsSync(outputDir)) {
            try {
              const names = readdirSync(outputDir);
              const withStat = names
                .filter((name) => ownedPrefixes.some((prefix) => name.startsWith(prefix)))
                .map((name) => {
                  const full = join(outputDir, name);
                  try {
                    const st = statSync(full);
                    return st.isFile() ? { name, mtime: st.mtimeMs } : null;
                  } catch {
                    return null;
                  }
                })
                .filter((x): x is { name: string; mtime: number } => x !== null);
              withStat.sort((a, b) => b.mtime - a.mtime);
              for (const { name } of withStat.slice(0, SESSION_FILES_OUTPUT_MAX)) {
                output.push({ path: `output/${name}`, name });
              }
            } catch {
              // ignore
            }
          }
        }
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ uploads, output }));
        return;
      }
      if (sessionId.trim()) {
        if (existsSync(uploadsDir)) {
          try {
            const names = readdirSync(uploadsDir);
            for (const name of names) {
              if (!name.startsWith(sessionId.trim() + "-")) continue;
              uploads.push({ path: `uploads/${name}`, name });
            }
          } catch {
            // ignore
          }
        }
      }
      if (existsSync(outputDir)) {
        try {
          const names = readdirSync(outputDir);
          const withStat = names
            .map((name) => {
              const full = join(outputDir, name);
              try {
                const st = statSync(full);
                return st.isFile() ? { name, mtime: st.mtimeMs } : null;
              } catch {
                return null;
              }
            })
            .filter((x): x is { name: string; mtime: number } => x !== null);
          withStat.sort((a, b) => b.mtime - a.mtime);
          for (const { name } of withStat.slice(0, SESSION_FILES_OUTPUT_MAX)) {
            output.push({ path: `output/${name}`, name });
          }
        } catch {
          // ignore
        }
      }
      res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
      res.end(JSON.stringify({ uploads, output }));
      return;
    }
    if (req.method === "GET" && p === "/chat/gallery") {
      const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
      const sessionId = url.searchParams.get("session_id")?.trim() ?? "";
      if (!sessionId) {
        res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "session_id required" }));
        return;
      }
      let chatRepo = getChatRepository();
      if (!chatRepo && config.gateway?.chatsDbPath) {
        chatRepo = initDb(resolve(process.cwd(), config.gateway.chatsDbPath));
      }
      if (!chatRepo) {
        res.writeHead(503, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Chats DB not configured (gateway.chatsDbPath)" }));
        return;
      }
      try {
        const messages = chatRepo.getChatHistory(sessionId, userId);
        const images = collectGalleryImages(messages).filter((img) => {
          if (img.deleted) return false;
          return resolveAgentsFilePath(agentsDir, img.path) != null;
        });
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ images }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (req.method === "GET" && (p === "/chat/documents" || p === "/chat/assets-summary")) {
      const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
      const sessionId = url.searchParams.get("session_id")?.trim() ?? "";
      if (!sessionId) {
        res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "session_id required" }));
        return;
      }
      let chatRepo = getChatRepository();
      if (!chatRepo && config.gateway?.chatsDbPath) {
        chatRepo = initDb(resolve(process.cwd(), config.gateway.chatsDbPath));
      }
      if (!chatRepo) {
        res.writeHead(503, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Chats DB not configured (gateway.chatsDbPath)" }));
        return;
      }
      // Hosted mode: the disk scan below lists files by session-id PREFIX —
      // without an ownership check any tenant could enumerate another tenant's
      // files by guessing their session id. Single-key mode keeps one owner.
      if (isRegistrationIntended(config) && !chatRepo.chatExists(sessionId, userId)) {
        res.writeHead(403, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }
      try {
        const messages = chatRepo.getChatHistory(sessionId, userId);
        const images = collectGalleryImages(messages).filter((img) => {
          if (img.deleted) return false;
          return resolveAgentsFilePath(agentsDir, img.path) != null;
        });
        const fromMsgs = collectChatDocuments(messages);
        // Forked chats share files with their ancestors (links suffice), so disk
        // files saved under the ancestors' session prefixes belong here too.
        const ancestorSessionIds: string[] = [];
        let forkCursor = sessionId;
        for (let depth = 0; depth < 10; depth++) {
          const parent = chatRepo.getForkParent(forkCursor, userId);
          if (!parent) break;
          ancestorSessionIds.push(parent);
          forkCursor = parent;
        }
        const fromDisk = mergeChatDocuments(
          collectSessionPrefixedDocuments(sessionId, {
            outputDir,
            uploadsDir,
          }),
          ...ancestorSessionIds.map((id) =>
            collectSessionPrefixedDocuments(id, { outputDir, uploadsDir })
          )
        );
        const documents = mergeChatDocuments(fromMsgs, fromDisk).filter(
          (d) => resolveAgentsFilePath(agentsDir, d.path) != null
        );
        if (p === "/chat/assets-summary") {
          res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(
            JSON.stringify({
              imageCount: images.length,
              documentCount: documents.length,
            })
          );
          return;
        }
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ documents }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (req.method === "DELETE" && p.startsWith("/files/")) {
      let rel: string;
      try {
        rel = decodeURIComponent(p.slice(7)).replace(/^\/+/, "").replace(/\.\./g, "");
      } catch {
        res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Bad Request" }));
        return;
      }
      const segments = rel.split("/").filter(Boolean);
      if (segments.length !== 2 || !DOWNLOAD_ALLOWED_SUBDIRS.includes(segments[0])) {
        res.writeHead(403, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }
      if (!isImagePath(segments[1]) && !isDocumentPath(segments[1])) {
        res.writeHead(400, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Only image or document files can be deleted" }));
        return;
      }
      const fullPath = resolveAgentsFileSafe(agentsDir, rel, { allowMissing: true });
      if (!fullPath) {
        // Includes planted-symlink paths: skill-writable dirs must not become
        // a bridge to arbitrary gateway files.
        res.writeHead(403, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }
      const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
      const sessionId = url.searchParams.get("session_id")?.trim() ?? "";
      // Hosted mode: deletion is tied to an owned chat (the web client always
      // passes session_id). Without an owned session the delete is refused —
      // /files cannot carry per-user auth itself (browser <img>/downloads send
      // no headers), so this is the boundary that matters for destructive ops.
      if (isRegistrationIntended(config)) {
        const chatRepo = getChatRepository();
        if (!sessionId || !chatRepo || !chatRepo.chatExists(sessionId, userId)) {
          res.writeHead(403, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end(JSON.stringify({ error: "Forbidden" }));
          return;
        }
      }
      try {
        // We delete the file in both primary and legacy (if both exist).
        const roots = [agentsDir, resolve(process.cwd(), "agents")];
        const seen = new Set<string>();
        for (const root of roots) {
          const candidate = resolveAgentsFileSafe(root, rel);
          if (!candidate || seen.has(candidate)) continue;
          seen.add(candidate);
          if (existsSync(candidate)) {
            const st = statSync(candidate);
            if (!st.isFile()) {
              res.writeHead(404, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
              res.end(JSON.stringify({ error: "Not Found" }));
              return;
            }
            unlinkSync(candidate);
          }
        }
        if (sessionId) {
          let chatRepo = getChatRepository();
          if (!chatRepo && config.gateway?.chatsDbPath) {
            chatRepo = initDb(resolve(process.cwd(), config.gateway.chatsDbPath));
          }
          if (chatRepo) {
            const messages = chatRepo.getMessages(sessionId, userId);
            if (messages.length && isImagePath(segments[1])) {
              const marked = markImageDeletedInMessages(messages, `/files/${rel}`);
              chatRepo.replaceMessages(sessionId, userId, marked);
            }
          }
        }
        res.writeHead(200, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ ok: true, path: rel }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Access-Control-Allow-Origin": corsOrigin });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (req.method === "GET" && p.startsWith("/files/")) {
      const rel = filePath;
      if (!rel) {
        res.writeHead(403, { "Content-Type": TEXT_TYPE });
        res.end("Forbidden");
        return;
      }
      const segments = rel.split("/");
      if (registrationGateActive) {
        const k = new URLSearchParams(req.url?.split("?", 2)[1]).get("k") ?? "";
        const secret = config.gateway?.auth?.sessionSecret?.trim() ?? "";
        if (verifyFilesToken(secret, k, rel)?.userId !== userId) {
          res.writeHead(401, { "Content-Type": TEXT_TYPE, "Access-Control-Allow-Origin": corsOrigin });
          res.end("Unauthorized");
          return;
        }
      }
      const fullPath = resolveAgentsFileSafe(agentsDir, rel);
      if (!fullPath) {
        res.writeHead(404, { "Content-Type": TEXT_TYPE });
        res.end("Not Found");
        return;
      }
      try {
        // Symlinks are refused at every path component (resolveAgentsFileSafe);
        // O_NOFOLLOW closes the check-then-open race on the final component:
        // an agent-writable output dir must not become a bridge to arbitrary
        // host files via /files/.
        // Swap detection between the component walk and the open: a planted
        // symlink in an intermediate directory would redirect this read with
        // gateway privileges. dev/ino mismatch -> refuse.
        const reWalk = safeRealPath(fullPath);
        if (!reWalk.ok || !verifyComponents(reWalk.components)) {
          res.writeHead(404, { "Content-Type": TEXT_TYPE });
          res.end("Not Found");
          return;
        }
        const lst = lstatSync(fullPath);
        if (lst.isSymbolicLink() || !lst.isFile()) {
          res.writeHead(404, { "Content-Type": TEXT_TYPE });
          res.end("Not Found");
          return;
        }
        const ext = (segments[segments.length - 1]?.split(".").pop() ?? "").toLowerCase();
        const imageTypes: Record<string, string> = {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          webp: "image/webp",
          svg: "image/svg+xml",
        };
        const avTypes: Record<string, string> = {
          mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
          aac: "audio/aac", flac: "audio/flac", mp4: "video/mp4", webm: "video/webm",
          mov: "video/quicktime",
        };
        const ct =
          ext === "docx"
            ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            : ext === "pdf"
              ? "application/pdf"
              : (Object.hasOwn(imageTypes, ext) ? imageTypes[ext] : undefined) ??
                (Object.hasOwn(avTypes, ext) ? avTypes[ext] : undefined) ?? "application/octet-stream";
        const name = segments[segments.length - 1] ?? "download";
        // SVG can carry scripts: it always downloads instead of rendering on
        // the gateway origin (stored-XSS closure); nosniff + sandbox CSP for
        // the whole /files/ surface.
        const inline = (Object.hasOwn(imageTypes, ext) && ext !== "svg") || Object.hasOwn(avTypes, ext);
        const forceDownload =
          typeof req.url === "string" &&
          new URL(req.url, "http://localhost").searchParams.get("download") === "1";
        const data = readFileSync(fullPath, {
          flag: noFollowFlag(fsConstants.O_RDONLY) as unknown as string,
        });
        res.writeHead(200, {
          "Content-Type": ct,
          "Content-Disposition":
            inline && !forceDownload ? "inline" : contentDispositionAttachment(name),
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox",
          "Cache-Control": "private, no-store",
          "Referrer-Policy": "no-referrer",
          "Access-Control-Allow-Origin": corsOrigin,
        });
        res.end(data);
      } catch {
        res.writeHead(500, { "Content-Type": TEXT_TYPE });
        res.end("Error");
      }
      return;
    }
    // Built-in wiki (landing/wiki shell + markdown pages): served same-origin
    // so the cabinet "Help" link works offline and without external sites.
    // When no wiki directory is configured (e.g. plain desktop runs), the
    // request falls back to the public product wiki site.
    const wikiPath = process.env.CLAW2_WIKI_PATH?.trim()
      ? resolve(process.env.CLAW2_WIKI_PATH)
      : undefined;
    if (req.method === "GET" && (p === "/wiki" || p.startsWith("/wiki/"))) {
      if (!wikiPath || !existsSync(join(wikiPath, "index.html"))) {
        res.writeHead(302, { Location: "https://claw2.online/wiki/#/en/Home.md" });
        res.end();
        return;
      }
      try {
        const sub = p.slice("/wiki".length).replace(/^\/+/, "") || "index.html";
        const file = resolve(join(wikiPath, sub === "" ? "index.html" : sub));
        if (isInsideRoot(wikiPath, file) && existsSync(file) && statSync(file).isFile()) {
          const ext = sub.split(".").pop() ?? "";
          const ct =
            ext === "html"
              ? "text/html; charset=utf-8"
              : ext === "md"
                ? "text/markdown; charset=utf-8"
                : ext === "json"
                  ? "application/json"
                  : ext === "css"
                    ? "text/css"
                    : ext === "js"
                      ? "application/javascript"
                      : ext === "svg"
                        ? "image/svg+xml"
                        : "application/octet-stream";
          res.writeHead(200, { "Content-Type": ct });
          res.end(
            readFileSync(file, ext === "html" || ext === "md" || ext === "css" || ext === "js" || ext === "json" ? "utf-8" : undefined)
          );
          return;
        }
        // A miss inside pages/ must NOT fall back to the shell: the shell
        // fetches pages relative to its URL, and a deep link like
        // /wiki/ru/How-To/X resolves the fetch to .../How-To/pages/ru/X —
        // serving the shell HTML with 200 made the shell render itself as
        // page content (nested shell, eternal "Loading…"). 404 breaks the loop.
        if (sub.startsWith("pages/")) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
          return;
        }
        // Unknown sub-path under a configured wiki: shell handles hash routing.
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(readFileSync(join(wikiPath, "index.html"), "utf-8"));
        return;
      } catch {
        res.writeHead(500, { "Content-Type": TEXT_TYPE });
        res.end("Error");
        return;
      }
    }
    const pwaPath = process.env.CLAW2_PWA_PATH?.trim() ? resolve(process.env.CLAW2_PWA_PATH) : undefined;
    if (req.method === "GET" && pwaPath && p.startsWith("/pwa")) {
      const sub = p.slice(4).replace(/^\/+/, "") || "index.html";
      const file = resolve(join(pwaPath, sub === "" ? "index.html" : sub));
      if (isInsideRoot(pwaPath, file) && existsSync(file)) {
        try {
          const st = statSync(file);
          if (st.isFile()) {
            const ext = sub.split(".").pop() ?? "";
            const ct =
              ext === "html"
                ? "text/html; charset=utf-8"
                : ext === "js"
                  ? "application/javascript"
                  : ext === "css"
                    ? "text/css"
                    : ext === "json"
                      ? "application/json"
                      : "application/octet-stream";
            res.writeHead(200, { "Content-Type": ct });
            res.end(readFileSync(file, ext === "html" || ext === "css" || ext === "js" ? "utf-8" : undefined));
            return;
          }
        } catch {
          // fall through
        }
      }
      if ((p === "/pwa" || p === "/pwa/") && existsSync(join(pwaPath, "index.html"))) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(readFileSync(join(pwaPath, "index.html"), "utf-8"));
        return;
      }
    }
    const staticPath = process.env.CLAW2_STATIC_PATH?.trim() ? resolve(process.env.CLAW2_STATIC_PATH) : undefined;
    if (req.method === "GET" && staticPath) {
      const indexFile = join(staticPath, "index.html");
      const spaRoutes =
        p === "/" ||
        p === "/index.html" ||
        p === "/chat" ||
        p.startsWith("/chat/") ||
        p === "/cabinet" ||
        p.startsWith("/cabinet/") ||
        p === "/gallery" ||
        p.startsWith("/gallery/") ||
        p === "/documents" ||
        p.startsWith("/documents/") ||
        p === "/calls" ||
        p.startsWith("/calls/") ||
        p === "/login" ||
        p === "/register";
      if (spaRoutes && existsSync(indexFile)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(readFileSync(indexFile, "utf-8"));
        return;
      }
      if (p.startsWith("/assets/")) {
        const file = resolve(join(staticPath, p.slice(1)));
        if (isInsideRoot(staticPath, file) && existsSync(file)) {
          const ext = p.split(".").pop() ?? "";
          const ct =
            ext === "js" ? "application/javascript" : ext === "css" ? "text/css" : "application/octet-stream";
          res.writeHead(200, { "Content-Type": ct });
          res.end(readFileSync(file));
          return;
        }
      } else if (p.startsWith("/")) {
        const file = resolve(join(staticPath, p.slice(1)));
        if (isInsideRoot(staticPath, file) && existsSync(file)) {
          const stat = statSync(file);
          if (stat.isFile()) {
            const ext = p.split(".").pop() ?? "";
            const ct =
              ext === "jpg" || ext === "jpeg" ? "image/jpeg"
              : ext === "png" ? "image/png" : ext === "svg" ? "image/svg+xml"
              : ext === "js" ? "application/javascript"
              : ext === "css" ? "text/css"
              : ext === "ico" ? "image/x-icon"
              : "application/octet-stream";
            res.writeHead(200, { "Content-Type": ct });
            res.end(readFileSync(file));
            return;
          }
        }
        // SPA fallback: unknown path without extension → index.html
        if (!extname(p) && existsSync(indexFile)) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(readFileSync(indexFile, "utf-8"));
          return;
        }
      }
    }
    if (req.method === "GET" && (p === "/" || p === "/chat")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getChatPageHtml());
      return;
    }
    res.writeHead(404, { "Content-Type": TEXT_TYPE, "Access-Control-Allow-Origin": corsOrigin });
    res.end("Not Found");
  });
}

export function startGateway(configRef: { current: Claw2Config }): void {
  const config = configRef.current;
  const port = config.gateway?.port ?? 3000;
  const bind = (config.gateway?.bind ?? "").trim() || undefined;
  const server = createGatewayServer(configRef);
  // A running chat turn must outlive the stop: docker stop, systemd and Ctrl+C end the gateway through it.
  installGracefulShutdown({ graceMs: config.gateway?.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS });

  const onListening = (): void => {
    mkdirSync(resolveAgentsUploadsDir(config), { recursive: true });
    mkdirSync(resolveAgentsOutputDir(config), { recursive: true });
    const addr = server.address();
    let listenUrl: string;
    if (addr && typeof addr === "object") {
      const host =
        addr.address === "::" ? "[::]" : addr.address === "::ffff:127.0.0.1" ? "127.0.0.1" : addr.address;
      listenUrl = `http://${host}:${addr.port}`;
    } else {
      listenUrl = bind ? `http://${bind}:${port}` : `http://0.0.0.0:${port}`;
    }
    console.error(`Gateway listening on ${listenUrl}${bind ? ` (bind=${bind})` : " (all interfaces)"}`);
    const authOff = config.gateway?.auth?.enabled !== true;
    const loopback =
      bind === "127.0.0.1" ||
      bind === "::1" ||
      bind === "localhost" ||
      bind === "[::1]";
    if (authOff && !loopback) {
      console.error(
        "[gateway] WARNING: auth.enabled=false while gateway is not bound to loopback" +
          ` (bind=${bind ?? "all interfaces"}). Unauthenticated API may be reachable on the LAN.` +
          " Prefer gateway.bind: 127.0.0.1 (desktop) or enable gateway.auth."
      );
    }
    if (isHttpsListening() && !loopback) {
      console.error(
        "[gateway] WARNING: remote HTTPS access is open while the plain HTTP gateway" +
          ` is bound to a non-loopback address (bind=${bind ?? "all interfaces"}). Clients that` +
          " bypass the TLS proxy reach it without the companion-token check —" +
          " for desktop remote access set gateway.bind: 127.0.0.1."
      );
    }
    console.error("POST /chat — body: { message, sessionId? }");
    // Fail-early surface for the sandbox-boundary config conflicts that would
    // otherwise fail per skill run with guard rejections.
    const siblingRoot = process.env.CLAW2_SIBLING_HOST_ROOT?.trim();
    if (siblingRoot) {
      const hostPath = config.uploads?.hostPath?.trim();
      if (hostPath) {
        const resolvedHost = resolve(hostPath);
        const resolvedRoot = resolve(siblingRoot);
        if (!resolvedHost.startsWith(resolvedRoot.endsWith("/") ? resolvedRoot : resolvedRoot + "/")) {
          console.error(
            "[gateway] CONFIG CONFLICT: uploads.hostPath (" + resolvedHost + ") is outside the" +
              " compose sandbox bind roots (" + resolvedRoot + "). The docker guard rejects such" +
              " binds — skill runs with uploads will fail. Move uploads inside " + resolvedRoot +
              " or add the host path to CLAW2_DOCKER_GUARD_ALLOWED_BIND_SRC."
          );
        }
      }
    }
    if ((process.env.DOCKER_HOST ?? "").trim().startsWith("tcp://") && !siblingRoot) {
      console.error(
        "[gateway] CONFIG CONFLICT: DOCKER_HOST is remote but CLAW2_SIBLING_HOST_ROOT is not set." +
          " Skill sandbox binds cannot be mapped to host paths — every skill run will fail" +
          " (set CLAW2_SIBLING_HOST_ROOT to the host directory that contains agents/ and data/)."
      );
    }
    if (config.channels?.telegram?.enabled) {
      try {
        startTelegramBot(config);
      } catch (err) {
        console.error("Telegram bot failed to start:", err);
      }
    } else {
      console.error("Telegram disabled (channels.telegram.enabled not true)");
    }
    if (config.channels?.vk?.enabled) {
      startVkBot(config);
    }
    if (config.scheduler?.enabled) {
      startScheduler(config);
    }
    startLlmBridge(config);
    void syncSipClient(config).catch((err) => console.error("[gateway] SIP start failed:", err));
    try {
      syncRemoteAccess(() => configRef.current);
    } catch (err) {
      console.error("[gateway] remote-access start failed:", err);
    }
  };

  if (bind) {
    server.listen(port, bind, onListening);
  } else {
    server.listen(port, onListening);
  }
}
