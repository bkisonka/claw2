/**
 * Shared ONNX embedding daemon (OpenAI-compatible).
 * First process to bind the port owns the model; others just call HTTP.
 *
 * Env:
 *   CLAW2_EMBED_HOST (default 127.0.0.1)
 *   CLAW2_EMBED_PORT (default 4872)
 *   CLAW2_EMBED_MODEL (default Xenova/bge-small-en-v1.5)
 *   CLAW2_EMBED_CACHE (default ~/.claw2/models)
 *   CLAW2_EMBED_DIM (default 384)
 *   CLAW2_EMBED_IDLE_MS (default 3600000 — unload & exit after idle)
 *   CLAW2_EMBED_PID_PATH (default ~/.claw2/embed-daemon.pid)
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  resolveEmbedIdleMs,
  resolveIdleCheckIntervalMs,
  shouldIdleExit,
} from "./embed-daemon-idle.js";

export const SHARED_EMBED_HOST = process.env.CLAW2_EMBED_HOST?.trim() || "127.0.0.1";
export const SHARED_EMBED_PORT = Number(process.env.CLAW2_EMBED_PORT || 4872);
export const SHARED_EMBED_MODEL =
  process.env.CLAW2_EMBED_MODEL?.trim() ||
  process.env.CLAW2_MEMORY_EMBEDDING_MODEL?.trim() ||
  "Xenova/bge-small-en-v1.5";
export const SHARED_EMBED_CACHE =
  process.env.CLAW2_EMBED_CACHE?.trim() || join(homedir(), ".claw2", "models");
export const SHARED_EMBED_DIM = Number(process.env.CLAW2_EMBED_DIM || 384);
export const SHARED_EMBED_PID_PATH =
  process.env.CLAW2_EMBED_PID_PATH?.trim() || join(homedir(), ".claw2", "embed-daemon.pid");
export const SHARED_EMBED_IDLE_MS = resolveEmbedIdleMs(process.env.CLAW2_EMBED_IDLE_MS);

type FeaturePipeline = (
  text: string,
  opts: { pooling: string; normalize: boolean },
) => Promise<{ data: Float32Array | number[] } | Float32Array | number[][]>;

let pipeline: FeaturePipeline | null = null;
let lastActivityAt = Date.now();
let idleTimer: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;
/** Only the daemon entrypoint may exit the process after shutdown (keeps tests/import safe). */
let exitProcessOnShutdown = false;

function touchActivity(): void {
  lastActivityAt = Date.now();
}

function writePidFile(pid: number): void {
  try {
    mkdirSync(dirname(SHARED_EMBED_PID_PATH), { recursive: true });
    writeFileSync(SHARED_EMBED_PID_PATH, String(pid), "utf8");
  } catch (err) {
    console.error("[embed-daemon] pid write failed", err);
  }
}

function clearPidFile(): void {
  try {
    if (existsSync(SHARED_EMBED_PID_PATH)) unlinkSync(SHARED_EMBED_PID_PATH);
  } catch {
    /* ignore */
  }
}

function releaseModel(): void {
  // Drop the only strong ref so ONNX/transformers can be GC'd before exit.
  pipeline = null;
}

function extractVector(output: unknown, dim: number): number[] {
  if (output && typeof output === "object" && "data" in (output as object)) {
    const data = (output as { data: Float32Array | number[] }).data;
    const arr = Array.from(data);
    return arr.length >= dim ? arr.slice(0, dim) : arr;
  }
  if (Array.isArray(output)) {
    if (typeof output[0] === "number") return (output as number[]).slice(0, dim);
    if (Array.isArray(output[0])) return ((output as number[][])[0] ?? []).slice(0, dim);
  }
  throw new Error("Unexpected embedding output shape");
}

async function getPipeline(): Promise<FeaturePipeline> {
  if (pipeline) return pipeline;
  mkdirSync(SHARED_EMBED_CACHE, { recursive: true });
  process.env.TRANSFORMERS_CACHE = SHARED_EMBED_CACHE;
  process.env.HF_HOME = SHARED_EMBED_CACHE;
  const transformers = await import("@huggingface/transformers");
  if (transformers.env) {
    transformers.env.cacheDir = SHARED_EMBED_CACHE;
    transformers.env.useFSCache = true;
  }
  console.error(`[embed-daemon] loading ${SHARED_EMBED_MODEL} (cache=${SHARED_EMBED_CACHE})…`);
  const extractor = await transformers.pipeline("feature-extraction", SHARED_EMBED_MODEL, {
    dtype: "fp32",
    cache_dir: SHARED_EMBED_CACHE,
  });
  pipeline = extractor as unknown as FeaturePipeline;
  console.error(`[embed-daemon] ready`);
  return pipeline;
}

async function embedOne(text: string): Promise<number[]> {
  touchActivity();
  const extractor = await getPipeline();
  const out = await extractor(String(text).slice(0, 8192), { pooling: "mean", normalize: true });
  const vec = extractVector(out, SHARED_EMBED_DIM);
  if (vec.length === SHARED_EMBED_DIM) return vec;
  const buf = new Array(SHARED_EMBED_DIM).fill(0);
  for (let i = 0; i < Math.min(vec.length, SHARED_EMBED_DIM); i++) buf[i] = vec[i];
  return buf;
}

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function sharedEmbedBaseURL(host = SHARED_EMBED_HOST, port = SHARED_EMBED_PORT): string {
  return `http://${host}:${port}/v1`;
}

export async function sharedEmbedHealthOk(
  host = SHARED_EMBED_HOST,
  port = SHARED_EMBED_PORT,
  timeoutMs = 400,
): Promise<boolean> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: ac.signal });
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean };
    return Boolean(data.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export async function requestEmbedDaemonShutdown(
  host = SHARED_EMBED_HOST,
  port = SHARED_EMBED_PORT,
  timeoutMs = 1500,
): Promise<boolean> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}/shutdown`, {
      method: "POST",
      signal: ac.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

function stopIdleWatch(): void {
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
}

async function shutdownServer(
  server: import("node:http").Server,
  reason: string,
): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  stopIdleWatch();
  console.error(`[embed-daemon] shutting down (${reason})`);
  releaseModel();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Force-close hangers so idle/Quit cannot leak the process.
    setTimeout(() => resolve(), 1500).unref?.();
  });
  clearPidFile();
  if (exitProcessOnShutdown) process.exit(0);
}

function startIdleWatch(server: import("node:http").Server): void {
  stopIdleWatch();
  const intervalMs = resolveIdleCheckIntervalMs(SHARED_EMBED_IDLE_MS);
  idleTimer = setInterval(() => {
    if (shouldIdleExit(lastActivityAt, Date.now(), SHARED_EMBED_IDLE_MS)) {
      void shutdownServer(server, `idle ${SHARED_EMBED_IDLE_MS}ms`);
    }
  }, intervalMs);
  // Keep the timer from pinning the event loop if the server is closed elsewhere.
  idleTimer.unref?.();
}

export function startEmbedDaemonServer(): import("node:http").Server {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${SHARED_EMBED_HOST}:${SHARED_EMBED_PORT}`);
      if (req.method === "GET" && url.pathname === "/health") {
        // Health must not reset idle — probes would keep the model loaded forever.
        return sendJson(res, 200, {
          ok: true,
          service: "claw2-embed-daemon",
          model: SHARED_EMBED_MODEL,
          dim: SHARED_EMBED_DIM,
          ready: Boolean(pipeline),
          idleMs: SHARED_EMBED_IDLE_MS,
          lastActivityAt,
        });
      }
      if (req.method === "POST" && url.pathname === "/shutdown") {
        sendJson(res, 200, { ok: true, shuttingDown: true });
        void shutdownServer(server, "shutdown request");
        return;
      }
      if (req.method === "POST" && (url.pathname === "/v1/embeddings" || url.pathname === "/embeddings")) {
        const raw = await readBody(req);
        const body = JSON.parse(raw || "{}") as { input?: string | string[]; model?: string };
        const inputs = Array.isArray(body.input) ? body.input : [String(body.input ?? "")];
        const data = [];
        for (let i = 0; i < inputs.length; i++) {
          data.push({ object: "embedding", index: i, embedding: await embedOne(inputs[i] ?? "") });
        }
        return sendJson(res, 200, {
          object: "list",
          model: body.model || SHARED_EMBED_MODEL,
          data,
          usage: { prompt_tokens: 0, total_tokens: 0 },
        });
      }
      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      console.error("[embed-daemon]", err);
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  return server;
}

async function main(): Promise<void> {
  exitProcessOnShutdown = true;
  const server = startEmbedDaemonServer();
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[embed-daemon] ${SHARED_EMBED_HOST}:${SHARED_EMBED_PORT} busy — another instance owns ONNX; exiting`,
      );
      process.exit(0);
    }
    console.error(err);
    process.exit(1);
  });

  const onSignal = (sig: string) => {
    void shutdownServer(server, sig);
  };
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));

  server.listen(SHARED_EMBED_PORT, SHARED_EMBED_HOST, () => {
    writePidFile(process.pid);
    touchActivity();
    startIdleWatch(server);
    console.error(
      `[embed-daemon] http://${SHARED_EMBED_HOST}:${SHARED_EMBED_PORT}/v1/embeddings idle=${SHARED_EMBED_IDLE_MS}ms`,
    );
    // Warm model in background so first client isn't cold alone
    void getPipeline().catch((e) => console.error("[embed-daemon] warm failed", e));
  });
}

const thisFile = fileURLToPath(import.meta.url);
const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && pathToFileURL(entry).href === pathToFileURL(thisFile).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
