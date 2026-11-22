// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Embeddings: HTTP (OpenAI-compatible / Ollama) or local ONNX (CPU).
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import OpenAI from "openai";
import type { Claw2Config } from "../config/types.js";
import {
  resolveEmbeddingDim,
  resolveEmbeddingProvider,
  DEFAULT_LOCAL_EMBEDDING_DIM,
} from "./sqlite-db.js";

const DEFAULT_HTTP_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_LOCAL_EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";

/** Timeout for embedding requests (Ollama may take a long time to load the model on the first request).*/
const EMBEDDING_REQUEST_TIMEOUT_MS = 120_000;

type FeaturePipeline = (
  text: string,
  opts: { pooling: string; normalize: boolean }
) => Promise<{ data: Float32Array | number[]; dims?: number[] } | Float32Array | number[][]>;

let localPipeline: FeaturePipeline | null = null;
let localPipelineModel: string | null = null;
let localPipelineLoading: Promise<FeaturePipeline> | null = null;

function getEmbeddingClient(config: Claw2Config, mainClient: OpenAI): OpenAI {
  const baseURL = config.memory?.embeddingBaseURL?.trim();
  if (baseURL) {
    const apiKey = config.memory?.embeddingApiKey?.trim() ?? config.llm?.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    return new OpenAI({
      apiKey,
      baseURL,
      timeout: EMBEDDING_REQUEST_TIMEOUT_MS,
    });
  }
  return mainClient;
}

function resolveLocalModelCacheDir(config: Claw2Config): string {
  const fromCfg = config.memory?.embeddingCacheDir?.trim();
  if (fromCfg) {
    const p = resolve(fromCfg);
    mkdirSync(p, { recursive: true });
    return p;
  }
  const p = join(homedir(), ".claw2", "models");
  mkdirSync(p, { recursive: true });
  return p;
}

export function resolveLocalEmbeddingModel(config: Claw2Config): string {
  const configured =
    config.memory?.embeddingModel?.trim() ||
    process.env.CLAW2_MEMORY_EMBEDDING_MODEL?.trim() ||
    "";
  // Local embeddings load an ONNX model from a HuggingFace repo id
  // ("Xenova/bge-small-en-v1.5"). A name without "/" is an HTTP-API model id
  // (e.g. "text-embedding-3-small" from the shipped config example): with
  // backend: sqlite the provider resolves to local and that name would make
  // the daemon try to download a nonexistent repo. Ignore it with a warning.
  if (configured.includes("/")) return configured;
  if (configured) {
    console.error(
      `[memory] embeddingModel "${configured}" is not a HuggingFace repo id — using ${DEFAULT_LOCAL_EMBEDDING_MODEL} for local embeddings (set embeddingModel to an HF repo or switch the provider to http)`
    );
  }
  return DEFAULT_LOCAL_EMBEDDING_MODEL;
}

async function getLocalPipeline(config: Claw2Config): Promise<FeaturePipeline> {
  const model = resolveLocalEmbeddingModel(config);
  if (localPipeline && localPipelineModel === model) return localPipeline;
  if (localPipelineLoading) return localPipelineLoading;

  localPipelineLoading = (async () => {
    const cacheDir = resolveLocalModelCacheDir(config);
    // transformers.js uses env.cacheDir (not HF_HOME / TRANSFORMERS_CACHE alone)
    process.env.TRANSFORMERS_CACHE = cacheDir;
    process.env.HF_HOME = cacheDir;

    const transformers = await import("@huggingface/transformers");
    if (transformers.env) {
      transformers.env.cacheDir = cacheDir;
      transformers.env.useFSCache = true;
    }
    console.error(`[memory] loading local embedding model ${model} (cache=${cacheDir})…`);
    const extractor = await transformers.pipeline("feature-extraction", model, {
      // CPU-friendly
      dtype: "fp32",
      cache_dir: cacheDir,
    });
    localPipeline = extractor as unknown as FeaturePipeline;
    localPipelineModel = model;
    console.error(`[memory] local embedding model ready: ${model}`);
    return localPipeline;
  })();

  try {
    return await localPipelineLoading;
  } finally {
    localPipelineLoading = null;
  }
}

function extractVector(output: unknown, expectedDim: number): number[] {
  // transformers.js feature-extraction with pooling+normalize often returns Tensor-like { data, dims }
  if (output && typeof output === "object" && "data" in (output as object)) {
    const data = (output as { data: Float32Array | number[] }).data;
    const arr = Array.from(data);
    if (arr.length === expectedDim) return arr;
    if (arr.length > expectedDim) return arr.slice(0, expectedDim);
    return arr;
  }
  if (Array.isArray(output)) {
    if (typeof output[0] === "number") return output as number[];
    if (Array.isArray(output[0])) return (output as number[][])[0] ?? [];
  }
  throw new Error("Local embedding: unexpected pipeline output shape");
}

async function getLocalEmbedding(config: Claw2Config, text: string): Promise<number[]> {
  const { ensureSharedEmbedDaemon, sharedEmbedBaseURL, SHARED_EMBED_MODEL } =
    await import("./ensure-shared-embed.js");
  const baseURL = await ensureSharedEmbedDaemon(config);
  const model = resolveLocalEmbeddingModel(config) || SHARED_EMBED_MODEL;
  const client = new OpenAI({
    apiKey: "local",
    baseURL: baseURL || sharedEmbedBaseURL(),
    timeout: EMBEDDING_REQUEST_TIMEOUT_MS,
  });
  const response = await client.embeddings.create({
    model,
    input: text.slice(0, 8192),
  });
  const vec = response.data[0]?.embedding;
  if (!vec || !Array.isArray(vec)) throw new Error("Empty embedding from shared daemon");
  return vec;
}

async function getHttpEmbedding(
  client: OpenAI,
  config: Claw2Config,
  text: string
): Promise<number[]> {
  const embeddingClient = getEmbeddingClient(config, client);
  const model =
    config.memory?.embeddingModel?.trim() ||
    process.env.CLAW2_MEMORY_EMBEDDING_MODEL?.trim() ||
    DEFAULT_HTTP_EMBEDDING_MODEL;
  const baseURL = config.memory?.embeddingBaseURL?.trim();
  try {
    const response = await embeddingClient.embeddings.create({
      model,
      input: text.slice(0, 8192),
    });
    const vec = response.data[0]?.embedding;
    if (!vec || !Array.isArray(vec)) throw new Error("Empty embedding");
    return vec;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (baseURL && (msg.includes("Connection") || msg.includes("ECONNREFUSED") || msg.includes("fetch"))) {
      const modelHint = config.memory?.embeddingModel
        ? `model ${config.memory.embeddingModel} loaded`
        : "embedding model loaded";
      throw new Error(
        `Embedding failed (${msg}). Check: the embedding service is running,${modelHint}, URL (${baseURL}) is available.`
      );
    }
    throw err;
  }
}

/**
 * Get text embedding (local ONNX or HTTP).
 */
export async function getEmbedding(
  client: OpenAI,
  config: Claw2Config,
  text: string
): Promise<number[]> {
  const provider = resolveEmbeddingProvider(config);
  if (provider === "local") {
    return getLocalEmbedding(config, text);
  }
  return getHttpEmbedding(client, config, text);
}

/** Smoke: ensure local model loads (or HTTP reachable). */
export async function warmEmbedding(config: Claw2Config, client?: OpenAI): Promise<{ ok: boolean; detail?: string; error?: string }> {
  try {
    const provider = resolveEmbeddingProvider(config);
    if (provider === "local") {
      const { ensureSharedEmbedDaemon, SHARED_EMBED_MODEL } = await import("./ensure-shared-embed.js");
      const base = await ensureSharedEmbedDaemon(config);
      const c = new OpenAI({ apiKey: "local", baseURL: base, timeout: EMBEDDING_REQUEST_TIMEOUT_MS });
      const vec = await getHttpEmbedding(
        c,
        {
          ...config,
          memory: {
            ...config.memory,
            embeddingBaseURL: base,
            embeddingModel: resolveLocalEmbeddingModel(config) || SHARED_EMBED_MODEL,
          },
        },
        "ping",
      );
      return {
        ok: true,
        detail: `shared-daemon ${resolveLocalEmbeddingModel(config)} dim=${vec.length} @ ${base}`,
      };
    }
    const c =
      client ??
      new OpenAI({
        apiKey: config.memory?.embeddingApiKey || config.llm?.apiKey || "local",
        baseURL: config.memory?.embeddingBaseURL || config.llm?.baseURL,
      });
    const vec = await getHttpEmbedding(c, config, "ping");
    return { ok: true, detail: `http dim=${vec.length}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Dot product by common prefix (different dimensions - 64-dim anchor vs 1024-dim BGE).
 */
export function similarity(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0;
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const av = a[i];
    const bv = b[i];
    if (typeof av !== "number" || typeof bv !== "number" || !Number.isFinite(av) || !Number.isFinite(bv)) {
      continue;
    }
    sum += av * bv;
  }
  return Number.isFinite(sum) ? sum : 0;
}

export { resolveEmbeddingProvider, resolveEmbeddingDim };
