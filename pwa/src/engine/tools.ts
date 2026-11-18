/**
 * In-app agent tools — every one is a direct HTTP call or pure JS,
 * no server component involved.
 */
import { evaluate } from "mathjs";
import { CapacitorHttp } from "@capacitor/core";
import { isNative } from "../native";
import { getSettings } from "./settings";
import { allMemory, remember, type MemoryChunk } from "./db";
import { embedTexts } from "./llm";
import { getFile, listFiles, saveFile, utf8ToBase64 } from "./files";

export type ToolOutcome = {
  content: string;
  cells?: { type: string; content: string }[];
};

/** Context threaded from the agent loop (which chat the tool acts in). */
export type ToolCtx = { chatId: string };

function norm(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Same 15s budget the desktop web-fetch uses — a dead proxy must never hang the turn. */
const FETCH_TIMEOUT_MS = 15_000;
const timeoutSignal = () => AbortSignal.timeout(FETCH_TIMEOUT_MS);

/* ---------- HTTP: native bridge first (no CORS outside the WebView engine),
 * then the WebView fetch, then (browser only) the relay. The tool traffic never
 * depends on an external server — on device it goes from the user's own IP. */

/** Browser-like UA: DDG serves the real SERP only to it (bare clients get a 202 challenge). */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** Browser-target fallback only: a hosted PWA cannot leave its CORS sandbox, so
 * dev/e2e in a browser may need a relaying endpoint (a small CORS relay —
 * deploy your own and put its URL with the `{url}` placeholder here). Empty means
 * the relay step is skipped. Native never uses it. */
const BROWSER_PROXY = "";

type HttpResult = { ok: boolean; status: number; body: string; error?: string };

type HttpInit = { method?: string; headers?: Record<string, string>; body?: string };

function errorResult(e: unknown): HttpResult {
  const msg = e instanceof Error ? e.message : String(e);
  return { ok: false, status: 0, body: "", error: /abort|timeout/i.test(msg) ? "timeout" : msg };
}

/** WebView fetch: works where the site permits our origin's CORS. */
async function webFetch(target: string, init?: HttpInit): Promise<HttpResult> {
  try {
    const res = await fetch(target, {
      method: init?.method ?? "GET",
      headers: init?.headers,
      body: init?.body,
      redirect: "follow",
      signal: timeoutSignal(),
    });
    const body = await res.text();
    return { ok: res.ok && !!body, status: res.status, body };
  } catch (e) {
    return errorResult(e);
  }
}

/** Native bridge fetch (CapacitorHttp): executed by the platform's HTTP stack,
 * no CORS at all. Whole-body (no streaming) — never use for the LLM SSE stream. */
async function nativeFetch(target: string, init?: HttpInit): Promise<HttpResult> {
  try {
    const res = await CapacitorHttp.request({
      url: target,
      method: init?.method ?? "GET",
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en,ru;q=0.8",
        ...(init?.headers ?? {}),
      },
      data: init?.body,
      connectTimeout: 10_000,
      readTimeout: FETCH_TIMEOUT_MS,
      responseType: "text",
    });
    const body = typeof res.data === "string" ? res.data : res.data == null ? "" : JSON.stringify(res.data);
    return { ok: res.status >= 200 && res.status < 300 && !!body, status: res.status, body };
  } catch (e) {
    return errorResult(e);
  }
}

function proxyUrl(target: string): string {
  return BROWSER_PROXY.replace("{url}", encodeURIComponent(target));
}

function tryJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

/**
 * Unified tool HTTP. On device: native bridge first (CORS-free, the user's own
 * IP), WebView fetch as a rare fallback, no external server involved. In a
 * browser: the WebView fetch runs first (CORS-permitting sites), then the relay;
 * a direct hit yielding no readable text still falls through — pick whichever
 * response has content.
 */
async function fetchTargetText(target: string, init?: HttpInit): Promise<HttpResult> {
  if (isNative()) {
    const viaNative = await nativeFetch(target, init);
    if (viaNative.ok || viaNative.error === "timeout") return viaNative;
    const direct = await webFetch(target, init);
    if (direct.ok) return direct;
    return { ok: false, status: viaNative.status, body: viaNative.error || direct.error || "fetch failed" };
  }
  const direct = await webFetch(target, init);
  if (direct.ok && looksLikeContent(direct.body)) return direct;
  if (!BROWSER_PROXY) {
    return direct.ok
      ? direct
      : { ok: false, status: direct.status, body: direct.error || "fetch failed" };
  }
  const via = await webFetch(proxyUrl(target), init);
  if (via.ok) return via;
  if (direct.ok) return direct;
  return { ok: false, status: via.status, body: via.error || direct.error || "fetch failed" };
}

/** Non-HTML payloads (JSON) always count as content; HTML needs visible text. */
function looksLikeContent(body: string): boolean {
  const head = body.trimStart().slice(0, 200);
  if (head.startsWith("{") || head.startsWith("[") || head.includes("application/json")) return true;
  if (!/<html|<!doctype/i.test(head)) return body.trim().length > 40;
  return htmlToReadableText(body).text.trim().length >= 40;
}

function htmlToReadableText(html: string, limit = 15000): { title: string; text: string } {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script,style,noscript,svg,iframe,form,nav,footer").forEach((el) => el.remove());
    const title = doc.querySelector("title")?.textContent?.trim() ?? "";
    const main = doc.querySelector("main,article") ?? doc.body;
    const text = (main?.textContent ?? "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { title, text: text.slice(0, limit) };
  } catch {
    return { title: "", text: html.slice(0, limit) };
  }
}

export async function toolFetchUrl(url: string): Promise<ToolOutcome> {
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const res = await fetchTargetText(target);
  if (!res.ok) return { content: `Не удалось загрузить ${target}: ${res.body || `HTTP ${res.status}`}` };
  if (/application\/json/i.test(res.body.slice(0, 200)) || res.body.trimStart().startsWith("{")) {
    return { content: res.body.slice(0, 15000) };
  }
  const { title, text } = htmlToReadableText(res.body);
  if (!text.trim()) return { content: `Страница ${target} загружена, но текста нет.` };
  return { content: `${title ? `${title}\n` : ""}${text}` };
}

/**
 * Fallback search without any API: DuckDuckGo SERP. On device this is a direct
 * native fetch (browser UA, the user's own IP); in a browser it relays through
 * the CORS proxy. HTML gets the selector parse, readable text passes as-is.
 */
async function searchViaDdg(query: string): Promise<ToolOutcome> {
  const serp = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetchTargetText(serp);
  if (!res.ok) {
    return {
      content: `Fallback-поиск недоступен (${res.body || `HTTP ${res.status}`}). Задайте API в Настройки → Поиск.`,
    };
  }
  if (!/<html|<!doctype|class="result/i.test(res.body.slice(0, 2000))) {
    // relay returned extracted text/markdown (reader-style) — hand it over
    return { content: res.body.slice(0, 8000) };
  }
  try {
    const doc = new DOMParser().parseFromString(res.body, "text/html");
    const items = [...doc.querySelectorAll(".result")].slice(0, 6).map((r) => {
      const a = r.querySelector(".result__a");
      const snip = r.querySelector(".result__snippet");
      const href = a?.getAttribute("href") ?? "";
      const decoded = href.includes("uddg=") ? decodeURIComponent(href.split("uddg=")[1].split("&")[0]) : href;
      return `- ${a?.textContent?.trim() ?? ""}: ${snip?.textContent?.trim() ?? ""}\n  ${decoded}`;
    });
    return items.length
      ? { content: items.join("\n\n") }
      : { content: "Fallback-поиск ничего не нашёл." };
  } catch {
    return { content: res.body.slice(0, 8000) };
  }
}

/* ---------- web_search ---------- */

export async function toolWebSearch(query: string): Promise<ToolOutcome> {
  const { search } = getSettings();
  if (!query.trim()) return { content: "Пустой запрос." };
  if (search.provider === "off") {
    // no API configured — built-in DDG fallback, same role as desktop web-fetch fallback
    return searchViaDdg(query);
  }
  try {
    if (search.provider === "tavily") {
      const res = await fetchTargetText("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: search.tavilyApiKey, query, search_depth: "advanced", max_results: 6 }),
      });
      if (!res.ok) return { content: `Tavily: HTTP ${res.status}` };
      const data = tryJson<{ results?: { title?: string; url?: string; content?: string }[] }>(res.body);
      const lines = (data?.results ?? []).map(
        (r) => `- ${r.title ?? ""}: ${r.content ?? ""}\n  ${r.url ?? ""}`
      );
      return { content: lines.join("\n\n") || "Ничего не найдено." };
    }
    const base = search.provider === "searxng" ? norm(search.searxngUrl) : norm(search.otherUrl);
    if (!base) return { content: "Поисковый эндпоинт не задан." };
    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
    const headers: Record<string, string> = {};
    const key = search.provider === "other" ? search.otherApiKey : "";
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetchTargetText(url, { headers });
    if (!res.ok) return { content: `Поиск: HTTP ${res.status}` };
    const data = tryJson<{ results?: { title?: string; url?: string; content?: string }[] }>(res.body);
    const lines = (data?.results ?? []).slice(0, 6).map(
      (r) => `- ${r.title ?? ""}: ${r.content ?? ""}\n  ${r.url ?? ""}`
    );
    return { content: lines.join("\n\n") || "Ничего не найдено." };
  } catch (e) {
    return { content: `Ошибка поиска: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/* ---------- calculate ---------- */

export function toolCalculate(expr: string): ToolOutcome {
  try {
    const value = evaluate(expr);
    return { content: `${expr} = ${typeof value === "number" ? String(value) : value?.toString?.() ?? String(value)}` };
  } catch (e) {
    return { content: `Ошибка вычисления: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/* ---------- generate_image ---------- */

export async function toolGenerateImage(prompt: string): Promise<ToolOutcome> {
  const { images } = getSettings();
  const base = norm(images.sdUrl);
  if (!base || !prompt.trim()) {
    return { content: "Генерация изображений не настроена (Настройки → Картинки)." };
  }
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (images.sdApiKey) headers.Authorization = `Bearer ${images.sdApiKey}`;
    // OpenAI-compatible first, then A1111 txt2img as fallback.
    const openaiRes = await fetchTargetText(`${base}/images/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt, n: 1, size: "1024x1024", response_format: "b64_json", model: images.sdModel || undefined }),
    });
    if (openaiRes.ok) {
      const data = tryJson<{ data?: { b64_json?: string; url?: string }[] }>(openaiRes.body);
      const item = data?.data?.[0];
      const src = item?.b64_json ? `data:image/png;base64,${item.b64_json}` : item?.url ?? "";
      if (src) {
        return { content: "Изображение сгенерировано.", cells: [{ type: "image", content: src }] };
      }
    }
    const aRes = await fetchTargetText(`${base}/sdapi/v1/txt2img`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt, steps: 20, width: 512, height: 512 }),
    });
    if (aRes.ok) {
      const data = tryJson<{ images?: string[] }>(aRes.body);
      const b64 = data?.images?.[0];
      if (b64) {
        return { content: "Изображение сгенерировано.", cells: [{ type: "image", content: `data:image/png;base64,${b64}` }] };
      }
    }
    return { content: `Генерация не удалась (${openaiRes.status || "?"}/${aRes.status || "?"}).` };
  } catch (e) {
    return { content: `Ошибка генерации: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Persist a generated image into the session file store (Картинки tab). */
export async function persistImage(chatId: string, dataUrl: string, nameHint: string): Promise<string | null> {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!m) return null;
  const ext = m[1].includes("png") ? "png" : m[1].includes("jpeg") ? "jpg" : m[1].includes("webp") ? "webp" : "bin";
  const name = `${(nameHint || "image").replace(/[^\wа-яА-ЯёЁ -]/g, "").trim().slice(0, 40) || "image"}.${ext}`;
  const meta = await saveFile(chatId, name, m[1], m[2]);
  return `/files/raw/${meta.id}`;
}

/* ---------- documents (virtual FS, like agents/output + /files/) ---------- */

async function buildDocxBase64(title: string, text: string): Promise<string> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import("docx");
  const lines = text.split("\n");
  const children = [
    new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
    ...lines.map(
      (line) =>
        new Paragraph({
          children: [new TextRun({ text: line, size: 24 })],
        })
    ),
  ];
  const doc = new Document({ sections: [{ properties: {}, children }] });
  return await Packer.toBase64String(doc);
}

export async function toolSaveDocument(
  ctx: ToolCtx,
  title: string,
  content: string,
  format: string
): Promise<ToolOutcome> {
  const fmt = (format || "md").toLowerCase();
  const safeTitle = (title || "Документ").replace(/[\\/\0]/g, "_").trim().slice(0, 80) || "Документ";
  if (!content?.trim()) return { content: "Пустое содержимое документа." };
  try {
    if (fmt === "docx") {
      const base64 = await buildDocxBase64(safeTitle, content);
      const meta = await saveFile(ctx.chatId, `${safeTitle}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", base64);
      return { content: `FILE_URL=/files/raw/${meta.id}\nДокумент «${meta.name}» сохранён в файлы сессии.` };
    }
    const ext = fmt === "html" ? "html" : fmt === "txt" ? "txt" : fmt === "csv" ? "csv" : "md";
    const mime = ext === "html" ? "text/html" : ext === "csv" ? "text/csv" : "text/markdown";
    const meta = await saveFile(ctx.chatId, `${safeTitle}.${ext}`, mime, utf8ToBase64(content));
    return { content: `FILE_URL=/files/raw/${meta.id}\nДокумент «${meta.name}» сохранён в файлы сессии.` };
  } catch (e) {
    return { content: `Не удалось сохранить документ: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function toolListFiles(ctx: ToolCtx): Promise<ToolOutcome> {
  const files = await listFiles(ctx.chatId);
  if (!files.length) return { content: "В сессии пока нет сохранённых файлов." };
  return { content: files.map((f) => `- ${f.name} (${f.mimeType}, /files/raw/${f.id})`).join("\n") };
}

export async function toolReadFile(ctx: ToolCtx, name: string): Promise<ToolOutcome> {
  const f = await getFile(ctx.chatId, name);
  if (!f) return { content: `Файл «${name}» не найден. Список: вызови list_files.` };
  if (!/^text\/|^application\/(json|xml)/.test(f.mimeType) && !/\.(md|txt|csv|html|json|xml|log)$/i.test(f.name)) {
    return { content: `«${f.name}» — бинарный файл (${f.mimeType}). Отдай пользователю ссылку /files/raw/${f.id}.` };
  }
  try {
    // Head-only decode: the tool returns 60k chars (≤ 240KB UTF-8 → ≤ 320KB
    // base64). A 15MB doc no longer pays a full atob + decode for its head.
    const cut = Math.floor(Math.min(f.base64.length, 327_680) / 4) * 4;
    const bin = atob(f.base64.slice(0, cut));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const text = new TextDecoder("utf-8").decode(bytes);
    return { content: text.slice(0, 60000) };
  } catch (e) {
    return { content: `Не удалось прочитать: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/* ---------- memory (remember / recall) ---------- */

const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

const keywords = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);

export async function toolRemember(text: string, source: string): Promise<ToolOutcome> {
  const { memory } = getSettings();
  let embedding: number[] | null = null;
  if (memory.embeddingBaseURL || memory.embeddingModel) {
    try {
      embedding = (await embedTexts([text]))[0] ?? null;
    } catch {
      embedding = null;
    }
  }
  await remember({ text, embedding, source });
  return { content: "Запомнено." };
}

export async function toolRecall(query: string, limit = 5): Promise<ToolOutcome> {
  const chunks = await allMemory();
  if (!chunks.length) return { content: "Память пуста." };
  const { memory } = getSettings();
  let scored: { chunk: MemoryChunk; score: number }[] = [];
  let queryVec: number[] | null = null;
  if (memory.embeddingBaseURL) {
    try {
      queryVec = (await embedTexts([query]))[0] ?? null;
    } catch {
      queryVec = null;
    }
  }
  if (queryVec) {
    scored = chunks.map((chunk) => ({
      chunk,
      score: chunk.embedding ? cosine(queryVec!, chunk.embedding) : 0,
    }));
  } else {
    const words = keywords(query);
    scored = chunks.map((chunk) => {
      const hay = chunk.text.toLowerCase();
      const score = words.reduce((acc, w) => acc + (hay.includes(w) ? 1 : 0), 0);
      return { chunk, score };
    });
  }
  const top = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  if (!top.length) return { content: "Ничего релевантного не нашлось." };
  return { content: top.map((t) => `- (${t.chunk.source}) ${t.chunk.text}`).join("\n") };
}

/* ---------- tool specs for the model ---------- */

export function enabledTools(): {
  specs: {
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }[];
} {
  const s = getSettings();
  const specs: ReturnType<typeof enabledTools>["specs"] = [];
  specs.push({
    type: "function",
    function: {
      name: "set_reminder",
      description:
        "Установить системное уведомление-напоминание (сработает на устройстве). text — что напомнить; datetime — 'YYYY-MM-DDTHH:mm', локальное время. Текущее время указано в системном промпте — относительные фразы («через 2 часа», «завтра в 9») разворачивай от него сам; спрашивай пользователя только если непонятна суть.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Текст напоминания" },
          datetime: { type: "string", description: "'YYYY-MM-DDTHH:mm', локальное время" },
        },
        required: ["text", "datetime"],
      },
    },
  });
  specs.push({
    type: "function",
    function: {
      name: "cancel_reminder",
      description: "Отменить напоминание: id или уникальный кусок его текста.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "id напоминания или кусок текста" } },
        required: ["id"],
      },
    },
  });
  specs.push({
    type: "function",
    function: {
      name: "calculate",
      description: "Вычислить математическое выражение (mathjs синтаксис).",
      parameters: {
        type: "object",
        properties: { expression: { type: "string", description: "например: 2^10 + sqrt(144)" } },
        required: ["expression"],
      },
    },
  });
  specs.push({
    type: "function",
    function: {
      name: "web_search",
      description: "Найти информацию в интернете (API или встроенный поиск без ключей).",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  });
  specs.push({
    type: "function",
    function: {
      name: "fetch_url",
      description: "Загрузить страницу/URL и вернуть её читаемый текст (аналог web-fetch).",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  });
  specs.push({
    type: "function",
    function: {
      name: "save_document",
      description:
        "Сохранить документ в файлы сессии. format: docx|md|html|txt|csv. Возвращает FILE_URL=/files/raw/<id> — упомяни его в ответе.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Название файла без расширения" },
          content: { type: "string", description: "Полный текст документа (markdown допустим)" },
          format: { type: "string", enum: ["docx", "md", "html", "txt", "csv"] },
        },
        required: ["title", "content"],
      },
    },
  });
  specs.push({
    type: "function",
    function: {
      name: "list_files",
      description: "Список файлов текущей сессии.",
      parameters: { type: "object", properties: {} },
    },
  });
  specs.push({
    type: "function",
    function: {
      name: "read_file",
      description: "Прочитать текстовый файл сессии по имени.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  });
  if (s.images.sdUrl.trim()) {
    specs.push({
      type: "function",
      function: {
        name: "generate_image",
        description: "Сгенерировать изображение по описанию.",
        parameters: {
          type: "object",
          properties: { prompt: { type: "string" } },
          required: ["prompt"],
        },
      },
    });
  }
  if (s.memory.enabled) {
    specs.push(
      {
        type: "function",
        function: {
          name: "remember",
          description: "Сохранить факт в долговременную память.",
          parameters: {
            type: "object",
            properties: { text: { type: "string" }, source: { type: "string" } },
            required: ["text"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "recall",
          description: "Найти релевантное в долговременной памяти.",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      }
    );
  }
  return { specs };
}
