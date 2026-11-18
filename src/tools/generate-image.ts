/**
 * generate_image tool: SD txt2img/img2img or OpenAI-compatible Images (generations/edits).
 * The result is a PNG in agents/output.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, relative, basename } from "node:path";
import type { Claw2Config } from "../config/types.js";
import { assertPublicUrl } from "../security/url-guard.js";
import { fetchPublic } from "../security/public-fetch.js";
import { resolveAgentsDir } from "../agents/paths.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_PROMPT_LENGTH = 2000;
const ALLOWED_IMAGE_SUBDIRS = ["output", "uploads"] as const;

export interface GenerateImageOptions {
  negative_prompt?: string;
  steps?: number;
  width?: number;
  height?: number;
  guidance_scale?: number;
  /** Path to the source for editing: /files/output/…, output/…, agents/output/…*/
  image?: string;
  /** Img2img strength 0.1–1 (default 0.65).*/
  strength?: number;
}

export type SdApiMode = "txt2img" | "openai";

/** Selecting a protocol: explicit sdApi or heuristics based on model/URL.*/
export function resolveSdApiMode(config: Claw2Config): SdApiMode {
  const explicit = config.tools?.sdApi;
  if (explicit === "txt2img" || explicit === "openai") return explicit;
  const model = config.tools?.sdModel?.trim();
  if (model) return "openai";
  const url = (config.tools?.sdUrl ?? process.env.CLAW2_SD_URL ?? "").trim().toLowerCase();
  if (!url) return "txt2img";
  if (url.includes("/v1") || /:11434\b/.test(url) || url.includes("openai.com")) return "openai";
  return "txt2img";
}

function openaiImagesBase(raw: string): string {
  let u = raw.trim().replace(/\/+$/, "");
  u = u.replace(/\/images\/(generations|edits)$/i, "");
  if (!/\/v1$/i.test(u)) u = `${u}/v1`;
  return u;
}

function agentsDirOf(config: Claw2Config): string {
  return resolveAgentsDir(config);
}

function savePng(config: Claw2Config, bytes: Buffer): { path: string; imageUrl: string } {
  const agentsDir = agentsDirOf(config);
  const outputDir = resolve(agentsDir, "output");
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  const filename = `generated-${Date.now()}.png`;
  const filePath = resolve(outputDir, filename);
  writeFileSync(filePath, bytes);
  return { path: `agents/output/${filename}`, imageUrl: `/files/output/${filename}` };
}

/**
 * Resolve the local image file only from agents/output|uploads.
 * Accepts /files/output/x.png, output/x.png, agents/output/x.png.
 */
export function resolveLocalImageFile(
  config: Claw2Config,
  imageRef: string
): { ok: true; fullPath: string; filename: string } | { ok: false; error: string } {
  let rel = imageRef.trim().replace(/\\/g, "/");
  if (!rel) return { ok: false, error: "image path is empty" };
  if (rel.startsWith("/files/")) rel = rel.slice("/files/".length);
  if (rel.startsWith("agents/")) rel = rel.slice("agents/".length);
  rel = rel.replace(/^\/+/, "").replace(/\.\./g, "");
  const segments = rel.split("/").filter(Boolean);
  if (segments.length !== 2 || !ALLOWED_IMAGE_SUBDIRS.includes(segments[0] as (typeof ALLOWED_IMAGE_SUBDIRS)[number])) {
    return {
      ok: false,
      error: "image must be under /files/output/… or /files/uploads/…",
    };
  }
  const agentsDir = agentsDirOf(config);
  const fullPath = resolve(agentsDir, segments[0], segments[1]);
  const fromAgents = relative(agentsDir, fullPath);
  if (fromAgents.startsWith("..")) {
    return { ok: false, error: "image path not allowed" };
  }
  if (!existsSync(fullPath)) {
    return { ok: false, error: `image file not found: /files/${segments[0]}/${segments[1]}` };
  }
  return { ok: true, fullPath, filename: basename(fullPath) };
}

function mimeFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/png";
}

async function generateViaTxt2img(
  config: Claw2Config,
  baseUrl: string,
  prompt: string,
  options: GenerateImageOptions,
  signal: AbortSignal
): Promise<{ ok: boolean; path?: string; imageUrl?: string; error?: string }> {
  const num = (v: unknown, def: number) =>
    typeof v === "number" && !Number.isNaN(v) ? v : typeof v === "string" ? Number(v) : def;
  const body = {
    prompt,
    negative_prompt: options.negative_prompt?.trim() || "",
    steps: Math.min(100, Math.max(1, num(options.steps, 25))),
    width: Math.min(1024, Math.max(256, num(options.width, 512))),
    height: Math.min(1024, Math.max(256, num(options.height, 512))),
    guidance_scale: Math.min(20, Math.max(1, num(options.guidance_scale, 7.5))),
  };
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/txt2img`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: `SD service error: ${res.status} ${text.slice(0, 200)}` };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const saved = savePng(config, buf);
  return { ok: true, ...saved };
}

async function generateViaImg2img(
  config: Claw2Config,
  baseUrl: string,
  prompt: string,
  imagePath: string,
  options: GenerateImageOptions,
  signal: AbortSignal
): Promise<{ ok: boolean; path?: string; imageUrl?: string; error?: string }> {
  const num = (v: unknown, def: number) =>
    typeof v === "number" && !Number.isNaN(v) ? v : typeof v === "string" ? Number(v) : def;
  const bytes = readFileSync(imagePath);
  const image_base64 = bytes.toString("base64");
  const body = {
    prompt,
    image_base64,
    negative_prompt: options.negative_prompt?.trim() || "",
    strength: Math.min(1, Math.max(0.1, num(options.strength, 0.65))),
    steps: Math.min(100, Math.max(1, num(options.steps, 25))),
    guidance_scale: Math.min(20, Math.max(1, num(options.guidance_scale, 7.5))),
  };
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/img2img`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: `SD img2img error: ${res.status} ${text.slice(0, 200)}` };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const saved = savePng(config, buf);
  return { ok: true, ...saved };
}

async function generateViaOpenAI(
  config: Claw2Config,
  baseUrl: string,
  prompt: string,
  options: GenerateImageOptions,
  signal: AbortSignal
): Promise<{ ok: boolean; path?: string; imageUrl?: string; error?: string }> {
  const model =
    config.tools?.sdModel?.trim() ||
    process.env.CLAW2_SD_MODEL?.trim() ||
    "";
  if (!model) {
    return {
      ok: false,
      error: "Image model not set (tools.sdModel) — required for OpenAI/Ollama Images API",
    };
  }
  const num = (v: unknown, def: number) =>
    typeof v === "number" && !Number.isNaN(v) ? v : typeof v === "string" ? Number(v) : def;
  const width = Math.min(1024, Math.max(256, num(options.width, 1024)));
  const height = Math.min(1024, Math.max(256, num(options.height, 1024)));
  const apiKey =
    config.tools?.sdApiKey?.trim() ||
    process.env.CLAW2_SD_API_KEY?.trim() ||
    "ollama";
  const endpoint = `${openaiImagesBase(baseUrl)}/images/generations`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  const body: Record<string, unknown> = {
    model,
    prompt,
    response_format: "b64_json",
    n: 1,
  };
  // Some providers (incl. Gemini) often reject size/steps — send size only when caller asked for width/height.
  const sizeRequested = options.width != null || options.height != null;
  if (sizeRequested) {
    body.size = `${width}x${height}`;
  }
  if (options.steps != null) {
    const steps = Math.min(100, Math.max(1, num(options.steps, 0)));
    if (steps > 0) body.steps = steps;
  }

  const post = (payload: Record<string, unknown>) =>
    fetch(endpoint, {
      method: "POST",
      signal,
      headers,
      body: JSON.stringify(payload),
    });

  let res = await post(body);
  if (!res.ok) {
    const text = await res.text();
    const retryable = /size|steps|temporar|unvail|unavailable|INVALID_DATA/i.test(text);
    if (retryable && (body.size != null || body.steps != null)) {
      const { size: _s, steps: _st, ...minimal } = body;
      console.error("[generate_image] retry without size/steps:", text.slice(0, 160));
      res = await post(minimal);
      if (!res.ok) {
        const text2 = await res.text();
        return { ok: false, error: `Image API error: ${res.status} ${text2.slice(0, 200)}` };
      }
    } else {
      return { ok: false, error: `Image API error: ${res.status} ${text.slice(0, 200)}` };
    }
  }
  const data = (await res.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  const first = data.data?.[0];
  if (first?.b64_json) {
    const buf = Buffer.from(first.b64_json, "base64");
    const saved = savePng(config, buf);
    return { ok: true, ...saved };
  }
  if (first?.url) {
    // The URL comes from the provider's answer — guard it like a tool fetch.
    const guard = await assertPublicUrl(first.url);
    if (!guard.ok) return { ok: false, error: guard.error };
    const imgRes = await fetchPublic(first.url, { signal: signal as never });
    if (!imgRes.ok) {
      return { ok: false, error: `Failed to download image URL: HTTP ${imgRes.status}` };
    }
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const saved = savePng(config, buf);
    return { ok: true, ...saved };
  }
  return { ok: false, error: "Image API returned no image data" };
}

/** OpenAI-compatible POST /v1/images/edits (multipart). */
async function generateViaOpenAIEdits(
  config: Claw2Config,
  baseUrl: string,
  prompt: string,
  imagePath: string,
  filename: string,
  options: GenerateImageOptions,
  signal: AbortSignal
): Promise<{ ok: boolean; path?: string; imageUrl?: string; error?: string }> {
  const model =
    config.tools?.sdModel?.trim() ||
    process.env.CLAW2_SD_MODEL?.trim() ||
    "";
  if (!model) {
    return {
      ok: false,
      error: "Image model not set (tools.sdModel) — required for OpenAI/Ollama Images edits",
    };
  }
  const apiKey =
    config.tools?.sdApiKey?.trim() ||
    process.env.CLAW2_SD_API_KEY?.trim() ||
    "ollama";
  const endpoint = `${openaiImagesBase(baseUrl)}/images/edits`;
  const bytes = readFileSync(imagePath);
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("response_format", "b64_json");
  form.append("n", "1");
  if (options.strength != null && Number.isFinite(options.strength)) {
    form.append("strength", String(Math.min(1, Math.max(0.1, options.strength))));
  }
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeFromName(filename) });
  form.append("image", blob, filename);

  const res = await fetch(endpoint, {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    return {
      ok: false,
      error:
        `Image edits API error: ${res.status} ${text.slice(0, 240)}. ` +
        `If the provider does not support /images/edits, use local SD (tools.sdApi=txt2img) with /img2img.`,
    };
  }
  const data = (await res.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  const first = data.data?.[0];
  if (first?.b64_json) {
    const buf = Buffer.from(first.b64_json, "base64");
    const saved = savePng(config, buf);
    return { ok: true, ...saved };
  }
  if (first?.url) {
    // The URL comes from the provider's answer — guard it like a tool fetch.
    const guard = await assertPublicUrl(first.url);
    if (!guard.ok) return { ok: false, error: guard.error };
    const imgRes = await fetchPublic(first.url, { signal: signal as never });
    if (!imgRes.ok) {
      return { ok: false, error: `Failed to download edited image URL: HTTP ${imgRes.status}` };
    }
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const saved = savePng(config, buf);
    return { ok: true, ...saved };
  }
  return { ok: false, error: "Image edits API returned no image data" };
}

export async function toolGenerateImage(
  config: Claw2Config,
  prompt: string,
  options: GenerateImageOptions = {}
): Promise<{ ok: boolean; path?: string; imageUrl?: string; error?: string; warning?: string }> {
  const baseUrl = (config.tools?.sdUrl ?? process.env.CLAW2_SD_URL ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    return { ok: false, error: "Image service not configured (tools.sdUrl or CLAW2_SD_URL)" };
  }
  const trimmed = prompt?.trim();
  if (!trimmed) {
    return { ok: false, error: "prompt is required" };
  }
  if (trimmed.length > MAX_PROMPT_LENGTH) {
    return { ok: false, error: `prompt too long (max ${MAX_PROMPT_LENGTH} chars)` };
  }

  let resolvedImage: { fullPath: string; filename: string } | null = null;
  if (options.image?.trim()) {
    const resolved = resolveLocalImageFile(config, options.image);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    resolvedImage = { fullPath: resolved.fullPath, filename: resolved.filename };
  }

  const lazyUrl = process.env.CLAW2_LAZY_URL?.trim();
  if (lazyUrl) {
    try {
      await fetch(`${lazyUrl.replace(/\/+$/, "")}/wake/sd`, { method: "POST" });
    } catch {
      // continue even if wake fails
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const mode = resolveSdApiMode(config);
    let result: { ok: boolean; path?: string; imageUrl?: string; error?: string; warning?: string };
    if (resolvedImage) {
      result =
        mode === "openai"
          ? await generateViaOpenAIEdits(
              config,
              baseUrl,
              trimmed,
              resolvedImage.fullPath,
              resolvedImage.filename,
              options,
              controller.signal
            )
          : await generateViaImg2img(
              config,
              baseUrl,
              trimmed,
              resolvedImage.fullPath,
              options,
              controller.signal
            );
      // Some providers (incl. Gemini) often respond with 422 IMAGE_NO_OUTPUT to edits - fallback to full generation.
      if (
        !result.ok &&
        mode === "openai" &&
        /IMAGE_NO_OUTPUT|no image|returned no image data/i.test(result.error ?? "")
      ) {
        console.error("[generate_image] edits failed, falling back to generations:", result.error);
        const fallback = await generateViaOpenAI(
          config,
          baseUrl,
          trimmed,
          options,
          controller.signal
        );
        clearTimeout(timeout);
        if (fallback.ok) {
          return {
            ...fallback,
            warning:
              "The provider did not return the image via /images/edits (IMAGE_NO_OUTPUT) - a complete regeneration (txt2img) was made using the same prompt.",
          };
        }
        return {
          ok: false,
          error: `${result.error} | fallback generations also failed: ${fallback.error}`,
        };
      }
    } else {
      result =
        mode === "openai"
          ? await generateViaOpenAI(config, baseUrl, trimmed, options, controller.signal)
          : await generateViaTxt2img(config, baseUrl, trimmed, options, controller.signal);
    }
    clearTimeout(timeout);
    if (!result.ok) {
      console.error("[generate_image] failed:", result.error);
    }
    return result;
  } catch (err) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[generate_image] exception:", msg);
    if (msg.includes("abort")) return { ok: false, error: "Image request timeout" };
    return { ok: false, error: msg };
  }
}
