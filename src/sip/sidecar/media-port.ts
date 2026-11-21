// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * PCM bridge over SMED: CapturePcm uplink queue + PlayPcm downlink.
 */
import { EventEmitter } from "node:events";
import { SIP_PCM_RATE } from "../audio.js";
import type { SidecarIpcClient } from "./ipc-client.js";
import { SmedIpcType } from "./protocol.js";

export class SidecarMediaPort extends EventEmitter {
  readonly sampleRate: number;
  readonly callId: string;
  private readonly ipc: SidecarIpcClient;
  private running = false;
  private interrupted = false;

  constructor(ipc: SidecarIpcClient, opts?: { sampleRate?: number; callId?: string }) {
    super();
    this.ipc = ipc;
    this.sampleRate = opts?.sampleRate && opts.sampleRate > 0 ? opts.sampleRate : SIP_PCM_RATE;
    this.callId = opts?.callId?.trim() || "";
  }

  start(): void {
    this.running = true;
    this.interrupted = false;
  }

  stop(): void {
    this.running = false;
    this.interruptPlayback();
  }

  /** Sidecar → claw2 (mic / RTP capture). */
  onCapturePcm(pcm: Buffer): void {
    if (!this.running || !pcm.length) return;
    this.emit("audio", pcm);
  }

  playPcm(pcm: Buffer, opts?: { finalize?: boolean }): void {
    if (!this.running || this.interrupted || !pcm.length) {
      if (opts?.finalize !== false) this.finalizePlayback();
      return;
    }
    try {
      this.ipc.send(SmedIpcType.PlayPcm, pcm);
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
    if (opts?.finalize !== false) this.finalizePlayback();
  }

  finalizePlayback(): void {
    if (!this.running || this.interrupted) return;
    try {
      this.ipc.send(SmedIpcType.PlayEos);
    } catch {
      /* ignore */
    }
  }

  interruptPlayback(): void {
    this.interrupted = true;
    try {
      this.ipc.send(SmedIpcType.Interrupt);
    } catch {
      /* ignore */
    }
  }

  clearInterrupted(): void {
    this.interrupted = false;
    try {
      this.ipc.send(SmedIpcType.ClearInterrupt);
    } catch {
      /* ignore */
    }
  }

  isInterrupted(): boolean {
    return this.interrupted;
  }
}
