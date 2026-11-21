// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import type { Claw2Config } from "../config/types.js";
import { assessLlmConfigured } from "../config/llm-ready.js";
import {
  openaiAudioBase,
  resolveSttApiKey,
  resolveSttLocal,
  resolveTtsApiKey,
  resolveTtsLocal,
  resolveVoiceSttUrl,
  resolveVoiceTtsUrl,
} from "../config/voice.js";
import { isPhoneCallToolEnabled } from "../config/sip.js";
import { getSipClient } from "../sip/client.js";

export type ConnectionState = "ok" | "error" | "off";

export type ConnectionCheck = {
  id: string;
  status: ConnectionState;
  /** Short explanation for ok*/
  detail?: string;
  /** Error text for error / off*/
  error?: string;
};

export type ConnectionsStatusResponse = {
  checkedAt: string;
  connections: ConnectionCheck[];
  /** First-run / settings hint */
  onboarding?: {
    needsLlmSetup: boolean;
    reason?: string;
  };
};

const TIMEOUT_MS = 6_000;

async function probeGet(
  url: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; body: string }> {
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body: body.slice(0, 240) };
  } catch (err) {
    // Node's fetch collapses the real cause (ECONNREFUSED, ENOTFOUND, "bad
    // port"…) into err.cause — surface it so the panel can say something
    // useful instead of the bare "fetch failed".
    const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
    return {
      ok: false,
      status: 0,
      body: `${err instanceof Error ? err.message : String(err)}${cause?.code ? ` (${cause.code})` : ""}${cause?.message ? ` ${cause.message}` : ""}`,
    };
  }
}

/**
 * Structured connection errors: `conn:<id>:<code>[:<arg>]`. The client maps
 * known codes to localized, human text ("LLM не подключена", …); unknown
 * strings render as-is. Keep codes stable — they are a UI contract.
 */
export type ConnectionErrorCode = {
  id: string;
  code: string;
  arg?: string;
};

export function parseConnectionErrorCode(
  error: string | undefined
): ConnectionErrorCode | null {
  if (!error || !error.startsWith("conn:")) return null;
  const parts = error.split(":");
  if (parts.length < 3 || parts[0] !== "conn") return null;
  const [, id, code] = parts;
  const arg = parts.length > 3 ? parts.slice(3).join(":") : undefined;
  return { id, code, arg };
}

function connError(id: string, code: string, arg?: string): string {
  return arg ? `conn:${id}:${code}:${arg}` : `conn:${id}:${code}`;
}

function urlTarget(url: string): { host: string; port: string; target: string } | null {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return { host, port, target: `${host}:${port}` };
  } catch {
    return null;
  }
}

function errText(probe: { status: number; body: string }, fallback: string): string {
  const b = probe.body.trim();
  if (b) {
    try {
      const j = JSON.parse(b) as { error?: string | { message?: string }; message?: string };
      if (typeof j.error === "string") return j.error.slice(0, 200);
      if (j.error && typeof j.error === "object" && j.error.message) return j.error.message.slice(0, 200);
      if (typeof j.message === "string") return j.message.slice(0, 200);
    } catch {
      /* plain text */
    }
    return b.slice(0, 200);
  }
  if (probe.status) return `HTTP ${probe.status}`;
  return fallback;
}

const LOCAL_HOSTS = /^(127\.0\.0\.1|localhost|::1|0\.0\.0\.0|host\.docker\.internal)$/;

/**
 * Classifies a network-layer LLM probe failure into a structured code.
 * Local targets (the operator's own machine) get actionable "start the
 * server" hints; remote API hosts fall back to the neutral base message —
 * "start the server" makes no sense for api.openai.com.
 */
export function llmNetworkCode(
  modelsUrl: string,
  probe: { status: number; body: string }
): string {
  const raw = probe.body.toLowerCase();
  const t = urlTarget(modelsUrl);
  const isLocal = !!t && LOCAL_HOSTS.test(t.host);
  if (raw.includes("econnrefused") || raw.includes("bad port")) {
    return connError("llm", "no_listener", t?.target);
  }
  if (raw.includes("enotfound") || raw.includes("getaddrinfo")) {
    return connError("llm", "unknown_host", t?.host);
  }
  if (raw.includes("timeout") || raw.includes("abort")) {
    return connError("llm", "timeout", String(TIMEOUT_MS / 1000));
  }
  if (isLocal) {
    return connError("llm", "no_connection", t?.target);
  }
  // Remote API: no more specific cause available — the neutral base wording.
  return connError("llm", "not_connected");
}

async function checkLlm(config: Claw2Config): Promise<ConnectionCheck> {
  const id = "llm";
  const assessed = assessLlmConfigured(config);
  if (!assessed.ok) {
    return { id, status: "error", error: connError(id, "not_configured") };
  }
  const baseURL = assessed.baseURL!;
  const apiKey = config.llm?.apiKey?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
  const modelsUrl = /\/v1$/i.test(baseURL) ? `${baseURL}/models` : `${baseURL}/v1/models`;
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  else if (assessed.localEndpoint) headers.Authorization = "Bearer ollama";
  const probe = await probeGet(modelsUrl, { headers });
  if (!probe.ok) {
    // Structured codes: the client renders localized human text
    // ("LLM не подключена", "неверный API-ключ (401)", …).
    if (probe.status > 0) {
      if (probe.status === 401 || probe.status === 403) {
        return { id, status: "error", error: connError(id, "bad_key") };
      }
      if (probe.status === 404) {
        return { id, status: "error", error: connError(id, "bad_path") };
      }
      return { id, status: "error", error: connError(id, "server_error", String(probe.status)) };
    }
    return { id, status: "error", error: llmNetworkCode(modelsUrl, probe) };
  }
  return { id, status: "ok", detail: config.llm?.model?.trim() || undefined };
}

async function checkVoiceStt(config: Claw2Config): Promise<ConnectionCheck> {
  const id = "voiceStt";
  const sttUrl = resolveVoiceSttUrl(config);
  if (!sttUrl) return { id, status: "off", error: "STT not configured" };

  if (resolveSttLocal(config)) {
    const healthUrl = sttUrl.replace(/\/stt\/?$/i, "") + "/health";
    const probe = await probeGet(healthUrl);
    if (probe.ok) return { id, status: "ok", detail: "local" };
    // fallback: base without /health
    const baseProbe = await probeGet(sttUrl.replace(/\/stt\/?$/i, "") || sttUrl);
    if (baseProbe.ok || baseProbe.status === 404 || baseProbe.status === 405) {
      return { id, status: "ok", detail: "local" };
    }
    return { id, status: "error", error: errText(probe, "Local STT unreachable") };
  }

  const apiKey = resolveSttApiKey(config);
  if (!apiKey) return { id, status: "error", error: "STT API key missing" };
  const modelsUrl = `${openaiAudioBase(sttUrl)}/models`;
  const probe = await probeGet(modelsUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!probe.ok) return { id, status: "error", error: errText(probe, "STT API unreachable") };
  return { id, status: "ok", detail: "remote" };
}

async function checkVoiceTts(config: Claw2Config): Promise<ConnectionCheck> {
  const id = "voiceTts";
  const ttsUrl = resolveVoiceTtsUrl(config);
  if (!ttsUrl) return { id, status: "off", error: "TTS not configured" };

  if (resolveTtsLocal(config)) {
    const healthUrl = ttsUrl.replace(/\/tts\/?$/i, "") + "/health";
    const probe = await probeGet(healthUrl);
    if (probe.ok) return { id, status: "ok", detail: "local" };
    const baseProbe = await probeGet(ttsUrl.replace(/\/tts\/?$/i, "") || ttsUrl);
    if (baseProbe.ok || baseProbe.status === 404 || baseProbe.status === 405) {
      return { id, status: "ok", detail: "local" };
    }
    return { id, status: "error", error: errText(probe, "Local TTS unreachable") };
  }

  const apiKey = resolveTtsApiKey(config);
  if (!apiKey) return { id, status: "error", error: "TTS API key missing" };
  const modelsUrl = `${openaiAudioBase(ttsUrl)}/models`;
  const probe = await probeGet(modelsUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!probe.ok) return { id, status: "error", error: errText(probe, "TTS API unreachable") };
  return { id, status: "ok", detail: "remote" };
}

async function checkSip(config: Claw2Config): Promise<ConnectionCheck> {
  const id = "sip";
  if (!isPhoneCallToolEnabled(config)) {
    return { id, status: "off", error: "SIP disabled or incomplete" };
  }
  const st = getSipClient().getStatus();
  if (!st.running) {
    return { id, status: "error", error: st.registerError || "SIP UA not running" };
  }
  if (!st.registered) {
    return { id, status: "error", error: st.registerError || "Not registered on PBX" };
  }
  return {
    id,
    status: "ok",
    detail: st.aor || `${st.user}@${st.domain}`,
  };
}

async function checkImages(config: Claw2Config): Promise<ConnectionCheck> {
  const id = "images";
  const sdUrl = (config.tools?.sdUrl ?? process.env.CLAW2_SD_URL ?? "").trim().replace(/\/+$/, "");
  if (!sdUrl) {
    return { id, status: "off", error: "Image generation not configured (tools.sdUrl)" };
  }
  if (config.tools?.sdEnabled === false) {
    return {
      id,
      status: "off",
      error: "Image generation disabled (tools.sdEnabled: false) — turn on in Settings",
    };
  }
  const apiKey = (config.tools?.sdApiKey ?? "").trim();
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  // OpenAI-compatible
  const modelsUrl = /\/v1$/i.test(sdUrl) ? `${sdUrl}/models` : `${sdUrl}/v1/models`;
  let probe = await probeGet(modelsUrl, { headers });
  if (probe.ok) return { id, status: "ok", detail: config.tools?.sdModel?.trim() || "api" };

  // txt2img / A1111-style
  probe = await probeGet(`${sdUrl}/`, { headers });
  if (probe.ok || probe.status === 404 || probe.status === 405) {
    return { id, status: "ok", detail: "service" };
  }
  return { id, status: "error", error: errText(probe, "Image service unreachable") };
}

async function checkSearch(config: Claw2Config): Promise<ConnectionCheck> {
  const id = "search";
  const { isSearchToolEnabled, resolveSearchProviderOrder, buildSearxngSearchUrl } =
    await import("../tools/search.js");

  if (!isSearchToolEnabled(config)) {
    return { id, status: "off", error: "Search not configured" };
  }

  const order = resolveSearchProviderOrder(config);
  const errors: string[] = [];

  for (const provider of order) {
    if (provider === "tavily") {
      const tavilyKey =
        config.tools?.tavily?.apiKey?.trim() || process.env.TAVILY_API_KEY?.trim() || "";
      const probe = await probeGet("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tavilyKey}`,
        },
        body: JSON.stringify({ query: "ping", max_results: 1 }),
      });
      if (probe.status === 200 || probe.status === 201) {
        return { id, status: "ok", detail: "Tavily" };
      }
      if (probe.status === 401) {
        errors.push("Tavily: invalid API key");
        continue;
      }
      const htmlForbidden =
        probe.status === 403 && /<!doctype html|<html[\s>]|403 Forbidden/i.test(probe.body);
      if (htmlForbidden) {
        errors.push("Tavily: API blocked (403 CDN/WAF)");
        continue;
      }
      if (probe.status === 403) {
        errors.push("Tavily: forbidden");
        continue;
      }
      if (probe.status === 0) {
        errors.push(`Tavily: ${probe.body || "network error"}`);
        continue;
      }
      errors.push(errText(probe, `Tavily HTTP ${probe.status || "?"}`));
      continue;
    }

    if (provider === "other") {
      const base = config.tools?.other?.url?.trim() || "";
      const apiKey =
        config.tools?.other?.apiKey?.trim() || process.env.SEARCH_OTHER_API_KEY?.trim() || "";
      const headers: Record<string, string> = { Accept: "application/json" };
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
        headers["X-Api-Key"] = apiKey;
      }
      const probeUrl = buildSearxngSearchUrl(base, "ping", 1);
      const probe = await probeGet(probeUrl, { method: "GET", headers });
      if (probe.status === 200 || probe.status === 201) {
        return { id, status: "ok", detail: "Other" };
      }
      if (probe.status === 401 || probe.status === 403) {
        errors.push(`Other: ${probe.status} (url/apiKey)`);
        continue;
      }
      if (probe.status === 0) {
        errors.push(`Other: ${probe.body || "network error"}`);
        continue;
      }
      errors.push(errText(probe, `Other HTTP ${probe.status || "?"}`));
      continue;
    }

    // searxng
    const base = config.tools?.searxng?.url?.trim() || "";
    const apiKey =
      config.tools?.searxng?.apiKey?.trim() || process.env.SEARXNG_API_KEY?.trim() || "";
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
      headers["X-Api-Key"] = apiKey;
    }
    const probeUrl = buildSearxngSearchUrl(base, "ping", 1);
    const probe = await probeGet(probeUrl, { method: "GET", headers });
    if (probe.status === 200 || probe.status === 201) {
      return { id, status: "ok", detail: "SearXNG" };
    }
    if (probe.status === 401 || probe.status === 403) {
      errors.push(`SearXNG: ${probe.status} (url/apiKey)`);
      continue;
    }
    if (probe.status === 0) {
      errors.push(`SearXNG: ${probe.body || "network error"}`);
      continue;
    }
    errors.push(errText(probe, `SearXNG HTTP ${probe.status || "?"}`));
  }

  return {
    id,
    status: "error",
    error: errors.join(" → ") || "Search unreachable",
  };
}

async function checkMemory(config: Claw2Config): Promise<ConnectionCheck> {
  const id = "memory";
  if (!config.memory?.enabled) {
    return { id, status: "off", error: "Memory disabled" };
  }
  const backend = config.memory.backend ?? "memory";
  if (backend === "memory") {
    return { id, status: "ok", detail: "in-memory" };
  }

  if (backend === "sqlite") {
    const { probeChronicleSqlite } = await import("../claw-cache/chronicle-sqlite.js");
    const { resolveEmbeddingProvider } = await import("../memory/sqlite-db.js");
    const { warmEmbedding } = await import("../memory/embedding.js");
    const dbProbe = probeChronicleSqlite(config);
    if (!dbProbe.ok) {
      return { id, status: "error", error: `sqlite: ${dbProbe.error ?? "open failed"}` };
    }
    const provider = resolveEmbeddingProvider(config);
    if (provider === "local") {
      const warm = await warmEmbedding(config);
      if (!warm.ok) {
        return {
          id,
          status: "error",
          error: `sqlite OK; local embedder: ${warm.error ?? "failed"}`,
        };
      }
      return {
        id,
        status: "ok",
        detail: `sqlite + ${warm.detail ?? "local"}`,
      };
    }
    // http embeddings + sqlite store
    const embBase = (
      config.memory.embeddingBaseURL?.trim() ||
      config.llm?.baseURL?.trim() ||
      process.env.OPENAI_BASE_URL?.trim() ||
      ""
    ).replace(/\/+$/, "");
    if (!embBase) {
      return {
        id,
        status: "error",
        error: "sqlite OK, but embeddingBaseURL / llm.baseURL not set (http provider)",
      };
    }
    const modelsUrl = /\/v1$/i.test(embBase) ? `${embBase}/models` : `${embBase}/v1/models`;
    const embKey =
      config.memory.embeddingApiKey?.trim() ||
      config.llm?.apiKey?.trim() ||
      process.env.OPENAI_API_KEY?.trim() ||
      "";
    const headers: Record<string, string> = {};
    if (embKey) headers.Authorization = `Bearer ${embKey}`;
    const embProbe = await probeGet(modelsUrl, { headers });
    if (!embProbe.ok) {
      return {
        id,
        status: "error",
        error: `sqlite OK; embeddings unreachable (${errText(embProbe, embBase)})`,
      };
    }
    const model = config.memory.embeddingModel?.trim();
    return {
      id,
      status: "ok",
      detail: model ? `sqlite + http embeddings (${model})` : "sqlite + http embeddings",
    };
  }

  // chroma (legacy)
  const url = (config.memory.chroma?.url ?? "").trim().replace(/\/+$/, "");
  if (!url) return { id, status: "error", error: "chroma.url not set" };

  let chromaOk = false;
  let chromaProbe = await probeGet(`${url}/api/v2/heartbeat`);
  if (chromaProbe.ok) chromaOk = true;
  else {
    chromaProbe = await probeGet(`${url}/api/v1/heartbeat`);
    if (chromaProbe.ok) chromaOk = true;
    else {
      chromaProbe = await probeGet(url);
      if (chromaProbe.ok || chromaProbe.status === 404) chromaOk = true;
    }
  }
  if (!chromaOk) {
    return { id, status: "error", error: `Chroma: ${errText(chromaProbe, "unreachable")}` };
  }

  const embBase = (
    config.memory.embeddingBaseURL?.trim() ||
    config.llm?.baseURL?.trim() ||
    process.env.OPENAI_BASE_URL?.trim() ||
    ""
  ).replace(/\/+$/, "");
  if (!embBase) {
    return {
      id,
      status: "error",
      error: "Chroma OK, but embeddingBaseURL / llm.baseURL not set",
    };
  }
  const modelsUrl = /\/v1$/i.test(embBase) ? `${embBase}/models` : `${embBase}/v1/models`;
  const embKey =
    config.memory.embeddingApiKey?.trim() ||
    config.llm?.apiKey?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    "";
  const headers: Record<string, string> = {};
  if (embKey) headers.Authorization = `Bearer ${embKey}`;
  const embProbe = await probeGet(modelsUrl, { headers });
  if (!embProbe.ok) {
    return {
      id,
      status: "error",
      error: `Chroma OK; embeddings unreachable (${errText(embProbe, embBase)})`,
    };
  }

  const model = config.memory.embeddingModel?.trim();
  return {
    id,
    status: "ok",
    detail: model ? `chroma + embeddings (${model})` : "chroma + embeddings",
  };
}

async function checkVision(config: Claw2Config): Promise<ConnectionCheck> {
  const id = "vision";
  if (!config.vision?.enabled) {
    return { id, status: "off", error: "Vision disabled" };
  }
  const url = (config.vision.recognizeUrl ?? "").trim().replace(/\/+$/, "");
  if (!url) {
    return { id, status: "ok", detail: "local (no URL)" };
  }
  const probe = await probeGet(url);
  if (probe.ok || probe.status === 404 || probe.status === 405 || probe.status === 400) {
    return { id, status: "ok", detail: "recognizeUrl" };
  }
  if (probe.status === 0) {
    return { id, status: "error", error: errText(probe, "Recognition service unreachable") };
  }
  return { id, status: "ok", detail: `HTTP ${probe.status}` };
}

export async function collectConnectionsStatus(config: Claw2Config): Promise<ConnectionsStatusResponse> {
  const connections = await Promise.all([
    checkLlm(config),
    checkVoiceStt(config),
    checkVoiceTts(config),
    checkSip(config),
    checkImages(config),
    checkSearch(config),
    checkMemory(config),
    checkVision(config),
  ]);
  const assessed = assessLlmConfigured(config);
  const llmConn = connections.find((c) => c.id === "llm");
  // Desktop: unreachable placeholder local LLM without a user key → still first-run setup
  const desktopNeedsSetup =
    process.env.CLAW2_DESKTOP === "1" &&
    !assessed.hasApiKey &&
    (assessed.needsSetup || llmConn?.status === "error");
  return {
    checkedAt: new Date().toISOString(),
    connections,
    onboarding: {
      needsLlmSetup: assessed.needsSetup || desktopNeedsSetup,
      reason:
        assessed.reason ||
        (desktopNeedsSetup ? "Connect a model (baseURL + API key) to start chatting" : undefined),
    },
  };
}
