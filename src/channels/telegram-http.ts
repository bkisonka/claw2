// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * HTTP client Bot API: only Telegram goes through proxyUrl (v2rayA / SSH -D).
 * LLM, voice, etc. - no proxy.
 */
import type { Claw2Config } from "../config/index.js";
import { fetch as undiciFetch, ProxyAgent, Socks5ProxyAgent, type Dispatcher, type RequestInit as UndiciRequestInit } from "undici";

export type TelegramHttpClient = {
  fetch: typeof globalThis.fetch;
  apiBase: string;
  fileBase: string;
  proxyUrl?: string;
};

function normalizeApiRoot(apiBaseUrl?: string): string {
  const raw = apiBaseUrl?.trim();
  if (raw) return raw.replace(/\/$/, "");
  return "https://api.telegram.org";
}

function resolveProxyUrl(config: Claw2Config): string | undefined {
  const fromEnv = process.env.TELEGRAM_PROXY_URL?.trim();
  if (fromEnv) return fromEnv;
  return config.channels?.telegram?.proxyUrl?.trim() || undefined;
}

/** socks5h → socks5 (remote DNS); ProxyAgent in undici only understands http(s) and socks5.*/
function createProxyDispatcher(proxyUrl: string): Dispatcher {
  const normalized = proxyUrl.replace(/^socks5h:/i, "socks5:").replace(/^socks4a:/i, "socks4:");
  const proto = new URL(normalized).protocol;
  if (proto === "socks5:" || proto === "socks:") {
    return new Socks5ProxyAgent(normalized);
  }
  if (proto === "http:" || proto === "https:") {
    return new ProxyAgent(normalized);
  }
  throw new Error(`Unsupported Telegram proxy URL protocol: ${proto}`);
}

export function createTelegramHttpClient(config: Claw2Config, token: string): TelegramHttpClient {
  const apiRoot = normalizeApiRoot(config.channels?.telegram?.apiBaseUrl);
  const proxyUrl = resolveProxyUrl(config);
  const dispatcher = proxyUrl ? createProxyDispatcher(proxyUrl) : undefined;

  const fetchFn: typeof globalThis.fetch = dispatcher
    ? (input, init) =>
        undiciFetch(input as string, { ...init, dispatcher } as UndiciRequestInit) as ReturnType<
          typeof globalThis.fetch
        >
    : globalThis.fetch.bind(globalThis);

  return {
    fetch: fetchFn,
    apiBase: `${apiRoot}/bot${token}`,
    fileBase: `${apiRoot}/file/bot${token}`,
    proxyUrl,
  };
}
