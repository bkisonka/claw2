// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * SipSidecarRuntime: spawn + SMED health + call/media control.
 * Fail → caller falls back to Node SipStack (no throw from tryStart).
 *
 * Hard rule: native binary is linux/amd64 only (see rag2 sip-media-sidecar).
 * Does not block gateway when SIP disabled or binary missing.
 */
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Claw2Config } from "../../config/types.js";
import { findSipSidecarBinary, resolveSipMediaBackend } from "../media-backend.js";
import { SidecarIpcClient } from "./ipc-client.js";
import { SidecarMediaPort } from "./media-port.js";
import { SmedIpcType } from "./protocol.js";
import {
  defaultSidecarIpcPath,
  ensureIpcParentDir,
  spawnSipSidecar,
  stopSipSidecarProcess,
} from "./spawn.js";

export type SidecarIncomingInfo = {
  callId: string;
  caller: string;
};

export type SidecarOutgoingInfo = {
  callId: string;
  target: string;
};

export type SidecarDialResult = {
  callId: string;
  ok: boolean;
  reason?: string;
};

export type SipSidecarStartResult =
  | { ok: true; runtime: SipSidecarRuntime }
  | { ok: false; reason: string };

export class SipSidecarRuntime extends EventEmitter {
  private config: Claw2Config;
  private ipc: SidecarIpcClient;
  private proc: ChildProcess | null = null;
  private ownsProcess = false;
  private media = new Map<string, SidecarMediaPort>();
  private started = false;
  private healthy = false;

  constructor(config: Claw2Config, ipcPath?: string) {
    super();
    this.config = config;
    this.ipc = new SidecarIpcClient(ipcPath || defaultSidecarIpcPath());
  }

  get isHealthy(): boolean {
    return this.healthy && this.ipc.isReady;
  }

  getMedia(callId: string): SidecarMediaPort | undefined {
    return this.media.get(callId);
  }

  ensureMedia(callId: string): SidecarMediaPort {
    let m = this.media.get(callId);
    if (!m) {
      m = new SidecarMediaPort(this.ipc, { callId });
      m.start();
      this.media.set(callId, m);
    }
    return m;
  }

  async start(opts?: { external?: boolean }): Promise<void> {
    if (this.started) return;
    if (process.platform === "win32") {
      throw new Error("sidecar not supported on Windows in v1");
    }

    const external =
      opts?.external === true ||
      process.env.CLAW2_SIP_SIDECAR_EXTERNAL?.trim() === "1" ||
      process.env.SIDECAR_EXTERNAL?.trim()?.toLowerCase() === "1" ||
      process.env.SIDECAR_EXTERNAL?.trim()?.toLowerCase() === "true";

    ensureIpcParentDir(this.ipc.path);

    if (!external) {
      const spawned = spawnSipSidecar(this.config, { ipcPath: this.ipc.path });
      this.proc = spawned.proc;
      this.ownsProcess = true;
      await sleep(300);
    } else {
      console.error(`[sip/sidecar] external mode — connect only ipc=${this.ipc.path}`);
    }

    this.ipc.on("message", (type, payload) => this.onMessage(type, payload));
    this.ipc.on("error", (err) => this.emit("error", err));
    this.ipc.on("close", () => {
      this.healthy = false;
      this.emit("disconnected");
    });

    let lastErr: Error | null = null;
    for (let i = 0; i < 30; i++) {
      try {
        await this.ipc.connect(2_000);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        await sleep(200);
      }
    }
    if (lastErr) {
      await this.stop().catch(() => undefined);
      throw new Error(`sidecar IPC health-check failed: ${lastErr.message}`);
    }

    this.started = true;
    this.healthy = true;
    console.error(`[sip/sidecar] health OK Ready ipc=${this.ipc.path}`);
    this.emit("ready");
  }

  async stop(): Promise<void> {
    this.healthy = false;
    this.started = false;
    for (const m of this.media.values()) m.stop();
    this.media.clear();
    await this.ipc.close().catch(() => undefined);
    if (this.ownsProcess) {
      await stopSipSidecarProcess(this.proc);
      this.ownsProcess = false;
    }
    this.proc = null;
  }

  answer(callId?: string): void {
    this.ipc.send(SmedIpcType.Answer, callId?.trim() || "");
  }

  hangup(callId: string): void {
    this.ipc.send(SmedIpcType.Hangup, callId.trim());
  }

  deny(callId: string): void {
    this.ipc.send(SmedIpcType.Deny, callId.trim());
  }

  transfer(callId: string, targetUri: string): void {
    this.ipc.send(SmedIpcType.Transfer, `${callId.trim()}\n${targetUri.trim()}`);
  }

  /**
   * Outbound INVITE via sidecar (SMED Dial). Resolves on DialResult ok after SIP 200.
   */
  dial(targetUri: string, timeoutMs = 60_000): Promise<{ callId: string }> {
    const target = targetUri.trim();
    if (!target) return Promise.reject(new Error("sidecar dial: empty target"));
    if (!this.isHealthy) return Promise.reject(new Error("sidecar dial: not healthy"));

    return new Promise((resolve, reject) => {
      let settled = false;
      let pendingCallId: string | null = null;

      const cleanup = () => {
        clearTimeout(timer);
        this.off("outgoing", onOutgoing);
        this.off("dial_result", onResult);
        this.off("call_ended", onEnded);
        this.off("error", onError);
      };

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const succeed = (callId: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ callId });
      };

      const timer = setTimeout(() => fail(new Error("sidecar dial timeout")), timeoutMs);

      const onOutgoing = (info: SidecarOutgoingInfo) => {
        pendingCallId = info.callId;
        this.ensureMedia(info.callId).start();
      };

      const onResult = (r: SidecarDialResult) => {
        if (pendingCallId && r.callId !== pendingCallId) return;
        if (!r.ok) {
          fail(new Error(r.reason?.trim() || "sidecar dial failed"));
          return;
        }
        succeed(r.callId);
      };

      const onEnded = (callId: string) => {
        if (pendingCallId && callId === pendingCallId && !settled) {
          fail(new Error("sidecar dial ended before connect"));
        }
      };

      const onError = (err: Error) => {
        // Ignore unrelated sidecar errors after we already have a call id unless dial fails fast.
        if (!pendingCallId) fail(err instanceof Error ? err : new Error(String(err)));
      };

      this.on("outgoing", onOutgoing);
      this.on("dial_result", onResult);
      this.on("call_ended", onEnded);
      this.on("error", onError);

      try {
        this.ipc.send(SmedIpcType.Dial, target);
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  playPcm(callId: string, pcm: Buffer, opts?: { finalize?: boolean }): void {
    this.ensureMedia(callId).playPcm(pcm, opts);
  }

  private onMessage(type: SmedIpcType, payload: Buffer): void {
    if (type === SmedIpcType.Incoming) {
      const text = payload.toString("utf8");
      const parts = text.split("\n", 2);
      const callId = (parts[0] || "").trim();
      const caller = (parts[1] || "").trim();
      if (!callId) return;
      const media = this.ensureMedia(callId);
      media.start();
      const info: SidecarIncomingInfo = { callId, caller };
      this.emit("incoming", info);
      return;
    }
    if (type === SmedIpcType.Outgoing) {
      const text = payload.toString("utf8");
      const parts = text.split("\n", 2);
      const callId = (parts[0] || "").trim();
      const target = (parts[1] || "").trim();
      if (!callId) return;
      const media = this.ensureMedia(callId);
      media.start();
      const info: SidecarOutgoingInfo = { callId, target };
      this.emit("outgoing", info);
      return;
    }
    if (type === SmedIpcType.DialResult) {
      const text = payload.toString("utf8");
      const lines = text.split("\n");
      const callId = (lines[0] || "").trim();
      const status = (lines[1] || "").trim().toLowerCase();
      const reason = lines.slice(2).join("\n").trim();
      if (!callId) return;
      const result: SidecarDialResult = {
        callId,
        ok: status === "ok",
        reason: status === "ok" ? undefined : reason || status || "error",
      };
      this.emit("dial_result", result);
      return;
    }
    if (type === SmedIpcType.CallEnded) {
      const callId = payload.toString("utf8").trim();
      const media = this.media.get(callId);
      if (media) {
        media.stop();
        this.media.delete(callId);
      }
      this.emit("call_ended", callId);
      return;
    }
    if (type === SmedIpcType.CapturePcm) {
      for (const media of this.media.values()) {
        media.onCapturePcm(payload);
      }
      return;
    }
    if (type === SmedIpcType.Error) {
      const msg = payload.toString("utf8") || "sidecar error";
      this.emit("error", new Error(msg));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Try start sidecar when mediaBackend resolves to sidecar.
 * Never throws to gateway: returns ok:false + reason for Node fallback.
 */
export async function tryStartSipSidecar(config: Claw2Config): Promise<SipSidecarStartResult> {
  const resolved = resolveSipMediaBackend(config);
  if (resolved.backend !== "sidecar") {
    return { ok: false, reason: resolved.reason };
  }
  if (process.platform === "win32") {
    return { ok: false, reason: "sidecar unsupported on win32 in v1; using node" };
  }
  if (!findSipSidecarBinary(config) && process.env.CLAW2_SIP_SIDECAR_EXTERNAL?.trim() !== "1") {
    return { ok: false, reason: "sidecar binary not found; using node" };
  }

  const runtime = new SipSidecarRuntime(config);
  try {
    await runtime.start();
    return { ok: true, runtime };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[sip/sidecar] start failed, fallback to node: ${reason}`);
    await runtime.stop().catch(() => undefined);
    return { ok: false, reason };
  }
}
