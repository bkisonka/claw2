// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Claw2Config } from "../config/types.js";
import {
  SHARED_EMBED_CACHE,
  SHARED_EMBED_DIM,
  SHARED_EMBED_HOST,
  SHARED_EMBED_MODEL,
  SHARED_EMBED_PID_PATH,
  SHARED_EMBED_PORT,
  embedDaemonMatches,
  requestEmbedDaemonShutdown,
  sharedEmbedBaseURL,
  sharedEmbedHealthInfo,
  sharedEmbedHealthOk,
} from "./embed-daemon.js";
import { resolveEmbeddingDim } from "./sqlite-db.js";
import { resolveLocalEmbeddingModel } from "./embedding.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let ensuring: Promise<string> | null = null;
let stopping: Promise<void> | null = null;

function packageRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = join(dir, "..");
  }
  return process.cwd();
}

function resolveDaemonEntry(): { cmd: string; args: string[]; cwd: string } {
  const root = packageRoot();
  const distJs = join(__dirname, "embed-daemon.js");
  if (existsSync(distJs) && __dirname.includes(`${join("dist", "memory")}`)) {
    return { cmd: process.execPath, args: [distJs], cwd: root };
  }
  const ts = join(root, "src", "memory", "embed-daemon.ts");
  const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  if (existsSync(ts) && existsSync(tsxCli)) {
    return { cmd: process.execPath, args: [tsxCli, ts], cwd: root };
  }
  if (existsSync(distJs)) {
    return { cmd: process.execPath, args: [distJs], cwd: root };
  }
  throw new Error("embed-daemon entry not found (build claw2 or keep src/memory/embed-daemon.ts)");
}

function readEmbedPid(): number | null {
  try {
    const raw = readFileSync(SHARED_EMBED_PID_PATH, "utf8").trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function clearEmbedPid(): void {
  try {
    if (existsSync(SHARED_EMBED_PID_PATH)) unlinkSync(SHARED_EMBED_PID_PATH);
  } catch {
    /* ignore */
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminatePid(pid: number): Promise<void> {
  if (!pidAlive(pid)) {
    clearEmbedPid();
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    clearEmbedPid();
    return;
  }
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      clearEmbedPid();
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* ignore */
  }
  clearEmbedPid();
}

function spawnDaemon(model: string, dim: number): void {
  const { cmd, args, cwd } = resolveDaemonEntry();
  const child = spawn(cmd, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      CLAW2_EMBED_HOST: SHARED_EMBED_HOST,
      CLAW2_EMBED_PORT: String(SHARED_EMBED_PORT),
      CLAW2_EMBED_MODEL: model,
      CLAW2_EMBED_CACHE: SHARED_EMBED_CACHE,
      CLAW2_EMBED_PID_PATH: SHARED_EMBED_PID_PATH,
      CLAW2_EMBED_DIM: String(dim),
    },
  });
  child.unref();
  console.error(
    `[embed] spawning shared daemon on ${SHARED_EMBED_HOST}:${SHARED_EMBED_PORT} (model=${model} dim=${dim} pid≈${child.pid ?? "?"})`,
  );
}

/**
 * Ensure the shared ONNX embed daemon is up AND serves the model the current
 * config expects with the expected dim. Safe to call after idle exit / Quit
 * restart: health miss → spawn. A healthy daemon left over from an earlier
 * model/config (e.g. a different embeddingDim or embeddingModel) is stopped
 * and respawned — reusing it silently fed the store wrong-dimension vectors
 * ("Embedding dim mismatch: got N, expected 384").
 */
export async function ensureSharedEmbedDaemon(
  config?: Claw2Config,
  opts?: { timeoutMs?: number }
): Promise<string> {
  if (ensuring) return ensuring;
  ensuring = (async () => {
    const base = sharedEmbedBaseURL();
    const wantModel = config ? resolveLocalEmbeddingModel(config) : SHARED_EMBED_MODEL;
    const wantDim = config ? resolveEmbeddingDim(config) : Number(SHARED_EMBED_DIM || 384);
    const info = await sharedEmbedHealthInfo();
    if (info) {
      if (embedDaemonMatches(info, wantModel, wantDim)) {
        console.error(`[embed] reusing shared daemon at ${base} (model=${info.model} dim=${info.dim})`);
        return base;
      }
      console.error(
        `[embed] shared daemon serves model=${info.model} dim=${info.dim}, want model=${wantModel} dim=${wantDim} — restarting`,
      );
      await stopSharedEmbedDaemon();
    }
    spawnDaemon(wantModel, wantDim);
    const deadline = Date.now() + (opts?.timeoutMs ?? 90_000);
    while (Date.now() < deadline) {
      const ready = await sharedEmbedHealthInfo(SHARED_EMBED_HOST, SHARED_EMBED_PORT, 800);
      if (embedDaemonMatches(ready, wantModel, wantDim)) {
        console.error(`[embed] shared daemon ready at ${base} (model=${wantModel} dim=${wantDim})`);
        return base;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(
      `Shared embed daemon did not become ready at ${base} (model=${wantModel} dim=${wantDim}) within timeout`,
    );
  })();
  try {
    return await ensuring;
  } finally {
    ensuring = null;
  }
}

/** Stop shared daemon (Quit / tests). Idempotent; does not throw. */
export async function stopSharedEmbedDaemon(): Promise<void> {
  if (stopping) return stopping;
  stopping = (async () => {
    const pid = readEmbedPid();
    try {
      if (await sharedEmbedHealthOk(SHARED_EMBED_HOST, SHARED_EMBED_PORT, 600)) {
        await requestEmbedDaemonShutdown();
        const deadline = Date.now() + 2500;
        while (Date.now() < deadline) {
          if (!(await sharedEmbedHealthOk(SHARED_EMBED_HOST, SHARED_EMBED_PORT, 300))) break;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    } catch {
      /* ignore */
    }
    if (pid != null) await terminatePid(pid);
    else clearEmbedPid();
  })();
  try {
    await stopping;
  } finally {
    stopping = null;
  }
}

export {
  sharedEmbedBaseURL,
  SHARED_EMBED_HOST,
  SHARED_EMBED_PORT,
  SHARED_EMBED_MODEL,
  SHARED_EMBED_PID_PATH,
};
