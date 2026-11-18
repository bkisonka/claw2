/**
 * Universal web search: one model-facing tool, pluggable providers.
 * Providers: tavily | searxng | other (SearXNG-compatible custom endpoint).
 */

import type { Claw2Config } from "../config/types.js";
import { throwIfAborted } from "../core/abort.js";

const DEFAULT_LIMIT = 10;
const TAVILY_API_URL = "https://api.tavily.com/search";

export type SearchProviderId = "tavily" | "searxng" | "other";

export type SearchHit = {
  title?: string;
  url?: string;
  description?: string;
  content?: string;
};

export type SearchProviderResult =
  | { ok: true; content: string; hits: SearchHit[]; provider: SearchProviderId }
  | { ok: false; error: string; provider: SearchProviderId };

function formatSearchResults(items: SearchHit[]): string {
  const lines = items.map((r, i) => {
    const title = r.title ?? "";
    const url2 = r.url ?? "";
    const snippet = r.description ?? r.content ?? "";
    return `${i + 1}. ${title}\n   ${url2}\n   ${snippet}`;
  });
  return lines.length ? lines.join("\n\n") : "No results.";
}

/** Markdown list for browser chat overlay (clickable links). */
export function formatSearchHitsMarkdown(hits: SearchHit[], query: string): string {
  const q = query.trim();
  const header = q ? `### Search: ${q}\n\n` : "";
  const body = hits
    .filter((h) => (h.url || "").trim())
    .map((h, i) => {
      const title = (h.title || h.url || "Result").trim();
      const url = (h.url || "").trim();
      const snip = (h.description || h.content || "").trim();
      const line = `${i + 1}. [${title}](${url})`;
      return snip ? `${line}\n   ${snip}` : line;
    })
    .join("\n\n");
  return body ? `${header}${body}` : `${header}No results.`;
}

function tavilyConfigured(config: Claw2Config): boolean {
  const t = config.tools?.tavily;
  if (t?.enabled === false) return false;
  return !!(t?.apiKey?.trim() || process.env.TAVILY_API_KEY?.trim());
}

function searxngConfigured(config: Claw2Config): boolean {
  const s = config.tools?.searxng;
  if (s?.enabled === false) return false;
  return !!s?.url?.trim();
}

function otherConfigured(config: Claw2Config): boolean {
  const o = config.tools?.other;
  if (o?.enabled === false) return false;
  return !!o?.url?.trim();
}

/**
 * Whether the model should see the search tool.
 * Always on: desktop can open a public SERP in the embedded browser;
 * API providers (Tavily/SearXNG) remain an optional fallback.
 */
export function isSearchToolEnabled(_config: Claw2Config): boolean {
  return true;
}

export type BrowserSearchEngine = {
  id: string;
  name: string;
  urlTemplate: string;
  enabled: boolean;
};

/** Built-in engines (merged with tools.search.browserEngines from config). */
export const DEFAULT_BROWSER_SEARCH_ENGINES: BrowserSearchEngine[] = [
  {
    id: "ddg",
    name: "DuckDuckGo",
    // Static HTML SERP — safest for Electron headless (Yandex/Google JS often SIGSEGVs on macOS).
    urlTemplate: "https://html.duckduckgo.com/html/?q={query}",
    enabled: true,
  },
  {
    id: "google",
    name: "Google",
    // gbv=1 = classic HTML results (no heavy JS shell).
    urlTemplate: "https://www.google.com/search?q={query}&gbv=1",
    enabled: true,
  },
  {
    id: "yandex",
    name: "Yandex",
    // Touch/HTML-leaning SERP — lighter than full desktop SPA (Electron crash risk).
    urlTemplate: "https://yandex.ru/search/touch/?text={query}",
    enabled: true,
  },
];

/** Merge defaults with user config (user overrides by id; custom ids append). */
export function resolveBrowserSearchEngines(config: Claw2Config): BrowserSearchEngine[] {
  const fromConfig = config.tools?.search?.browserEngines;
  const byId = new Map<string, BrowserSearchEngine>();
  for (const e of DEFAULT_BROWSER_SEARCH_ENGINES) {
    byId.set(e.id, { ...e });
  }
  if (Array.isArray(fromConfig)) {
    for (const raw of fromConfig) {
      if (!raw || typeof raw !== "object") continue;
      const id = String(raw.id ?? "").trim();
      const name = String(raw.name ?? "").trim();
      const urlTemplate = String(raw.urlTemplate ?? "").trim();
      if (!id || !name || !urlTemplate.includes("{query}")) continue;
      const prev = byId.get(id);
      byId.set(id, {
        id,
        name: name || prev?.name || id,
        urlTemplate,
        enabled: raw.enabled !== false,
      });
    }
  }
  // Stable order: defaults first, then custom ids
  const defaults = DEFAULT_BROWSER_SEARCH_ENGINES.map((d) => byId.get(d.id)!).filter(Boolean);
  const custom = [...byId.values()].filter(
    (e) => !DEFAULT_BROWSER_SEARCH_ENGINES.some((d) => d.id === e.id)
  );
  return [...defaults, ...custom];
}

export function buildBrowserSearchUrlFromTemplate(urlTemplate: string, query: string): string {
  const q = String(query ?? "").trim();
  return urlTemplate.split("{query}").join(encodeURIComponent(q));
}

/** Default single-engine SERP URL (first enabled, else DDG). */
export function buildBrowserSearchUrl(query: string, config?: Claw2Config): string {
  const engines = config
    ? resolveBrowserSearchEngines(config).filter((e) => e.enabled)
    : DEFAULT_BROWSER_SEARCH_ENGINES;
  const engine =
    engines[0] ?? DEFAULT_BROWSER_SEARCH_ENGINES.find((e) => e.id === "ddg") ?? DEFAULT_BROWSER_SEARCH_ENGINES[0]!;
  return buildBrowserSearchUrlFromTemplate(engine.urlTemplate, query);
}

/**
 * Pick engines for a search call (ordered preference / fallback chain).
 * - wanted empty/undefined → first enabled (fast default)
 * - wanted includes "all" → every enabled engine (caller tries one-by-one until hit)
 * - otherwise → intersection with enabled (by id or name); empty → first enabled
 */
export function pickBrowserSearchEngines(
  config: Claw2Config,
  wanted?: string[] | null
): BrowserSearchEngine[] {
  const all = resolveBrowserSearchEngines(config).filter((e) => e.enabled);
  if (all.length === 0) return [];
  if (!wanted || wanted.length === 0) return [all[0]!];
  const want = wanted.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  if (want.includes("all")) return all;
  const matched = all.filter(
    (e) => want.includes(e.id.toLowerCase()) || want.includes(e.name.toLowerCase())
  );
  return matched.length > 0 ? matched : [all[0]!];
}

/** Parse optional engines arg from tool call (string | string[]). */
export function parseSearchEnginesArg(raw: unknown): string[] | undefined {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return undefined;
    if (s.includes(",")) return s.split(",").map((x) => x.trim()).filter(Boolean);
    return [s];
  }
  return undefined;
}

/**
 * Resolve provider attempt order.
 * - explicit tavily / searxng / other → only that (if configured)
 * - auto → tavily first (legacy default), then searxng, then other
 */
export function resolveSearchProviderOrder(config: Claw2Config): SearchProviderId[] {
  const pref = (config.tools?.search?.provider ?? "auto").toLowerCase();
  if (pref === "tavily") return tavilyConfigured(config) ? ["tavily"] : [];
  if (pref === "searxng") return searxngConfigured(config) ? ["searxng"] : [];
  if (pref === "other") return otherConfigured(config) ? ["other"] : [];
  // auto
  const order: SearchProviderId[] = [];
  if (tavilyConfigured(config)) order.push("tavily");
  if (searxngConfigured(config)) order.push("searxng");
  if (otherConfigured(config)) order.push("other");
  return order;
}

/** Build SearXNG JSON API URL from base or …/search endpoint. */
export function buildSearxngSearchUrl(baseUrl: string, query: string, limit = DEFAULT_LIMIT): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const endpoint = /\/search$/i.test(trimmed) ? trimmed : `${trimmed}/search`;
  const url = new URL(endpoint);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  if (limit > 0) url.searchParams.set("number_of_results", String(Math.min(limit, 20)));
  return url.toString();
}

async function searchTavily(
  config: Claw2Config,
  query: string,
  signal?: AbortSignal
): Promise<SearchProviderResult> {
  throwIfAborted(signal);
  const key = (config.tools?.tavily?.apiKey ?? process.env.TAVILY_API_KEY ?? "").trim();
  if (!key) return { ok: false, error: "Tavily API key not set.", provider: "tavily" };
  const searchDepth = (config.tools?.tavily?.searchDepth ?? "basic") as
    | "basic"
    | "advanced"
    | "fast"
    | "ultra-fast";
  try {
    const body: { query: string; max_results: number; search_depth?: string } = {
      query,
      max_results: Math.min(DEFAULT_LIMIT, 20),
    };
    if (searchDepth && searchDepth !== "basic") body.search_depth = searchDepth;
    const res = await fetch(TAVILY_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal,
    });
    throwIfAborted(signal);
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 403 && /<!doctype html|<html[\s>]|403 Forbidden/i.test(text)) {
        return {
          ok: false,
          error:
            "Tavily: API blocked (403 CDN/WAF from this network). Key may be fine — use VPN/proxy or switch to searxng",
          provider: "tavily",
        };
      }
      return { ok: false, error: `Tavily: ${res.status} ${text.slice(0, 200)}`, provider: "tavily" };
    }
    const data = (await res.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    const results = Array.isArray(data?.results) ? data.results : [];
    const hits = results.map((r) => ({ title: r.title, url: r.url, description: r.content }));
    return { ok: true, content: formatSearchResults(hits), hits, provider: "tavily" };
  } catch (e) {
    throwIfAborted(signal);
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      provider: "tavily",
    };
  }
}

/** Shared SearXNG-compatible GET search (used by searxng and other). */
async function searchSearxngCompatible(
  provider: "searxng" | "other",
  base: string,
  apiKey: string,
  query: string,
  label: string,
  signal?: AbortSignal
): Promise<SearchProviderResult> {
  throwIfAborted(signal);
  if (!base) return { ok: false, error: `${label} url not set.`, provider };
  try {
    const url = buildSearxngSearchUrl(base, query);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
      headers["X-Api-Key"] = apiKey;
    }
    const timeoutSignal = AbortSignal.timeout(20_000);
    const fetchSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const res = await fetch(url, { method: "GET", headers, signal: fetchSignal });
    throwIfAborted(signal);
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          error: `${label}: ${res.status} (check url / apiKey). ${text.slice(0, 120)}`,
          provider,
        };
      }
      return {
        ok: false,
        error: `${label}: ${res.status} ${text.slice(0, 200)}`,
        provider,
      };
    }
    const data = (await res.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    const results = Array.isArray(data?.results) ? data.results : [];
    const hits = results.slice(0, DEFAULT_LIMIT).map((r) => ({
      title: r.title,
      url: r.url,
      description: r.content,
    }));
    return { ok: true, content: formatSearchResults(hits), hits, provider };
  } catch (e) {
    throwIfAborted(signal);
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      provider,
    };
  }
}

async function searchSearxng(
  config: Claw2Config,
  query: string,
  signal?: AbortSignal
): Promise<SearchProviderResult> {
  const base = config.tools?.searxng?.url?.trim() ?? "";
  const apiKey = (config.tools?.searxng?.apiKey ?? process.env.SEARXNG_API_KEY ?? "").trim();
  return searchSearxngCompatible("searxng", base, apiKey, query, "SearXNG", signal);
}

async function searchOther(
  config: Claw2Config,
  query: string,
  signal?: AbortSignal
): Promise<SearchProviderResult> {
  const base = config.tools?.other?.url?.trim() ?? "";
  const apiKey = (config.tools?.other?.apiKey ?? process.env.SEARCH_OTHER_API_KEY ?? "").trim();
  return searchSearxngCompatible("other", base, apiKey, query, "Other", signal);
}

async function runProvider(
  id: SearchProviderId,
  config: Claw2Config,
  query: string,
  signal?: AbortSignal
): Promise<SearchProviderResult> {
  if (id === "tavily") return searchTavily(config, query, signal);
  if (id === "other") return searchOther(config, query, signal);
  return searchSearxng(config, query, signal);
}

export async function toolSearch(
  config: Claw2Config,
  query: string,
  signal?: AbortSignal
): Promise<{
  ok: boolean;
  content?: string;
  hits?: SearchHit[];
  error?: string;
  provider?: SearchProviderId;
}> {
  throwIfAborted(signal);
  const q = String(query ?? "").trim();
  if (!q) return { ok: false, error: "query required" };

  const order = resolveSearchProviderOrder(config);
  if (order.length === 0) {
    return {
      ok: false,
      error:
        "Search not configured: set tools.tavily.apiKey, tools.searxng.url, and/or tools.other.url (optional tools.search.provider).",
    };
  }

  const errors: string[] = [];
  for (const id of order) {
    throwIfAborted(signal);
    const result = await runProvider(id, config, q, signal);
    if (result.ok) {
      return {
        ok: true,
        content: result.content,
        hits: result.hits,
        provider: result.provider,
      };
    }
    errors.push(`[${result.provider}] ${result.error}`);
  }

  return {
    ok: false,
    error: errors.join(" → ") || "Search failed.",
    provider: order[order.length - 1],
  };
}
