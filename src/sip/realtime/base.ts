// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Base Realtime adapter: EventEmitter + resample + uplink mute.
 * Concrete providers (Yandex / OpenAI / xAI) implement WS I/O.
 */
import { EventEmitter } from "node:events";
import { SIP_PCM_RATE } from "../audio.js";
import type { RealtimeProvider } from "./provider.js";
import { providerPcmToSip, sipPcmToProvider } from "./resample.js";
import {
  DEFAULT_REALTIME_PROVIDER_RATE,
  type RealtimeProviderId,
  type RealtimeSessionOptions,
  type RealtimeToolCall,
} from "./types.js";

export abstract class BaseRealtimeProvider extends EventEmitter implements RealtimeProvider {
  abstract readonly id: RealtimeProviderId;

  readonly sampleRate: number;
  readonly sipSampleRate: number;

  protected ready = false;
  protected closed = false;
  protected uplinkMuted = false;
  protected connectedAt = 0;
  private ttfaEmitted = false;

  constructor(opts?: { sampleRate?: number; sipSampleRate?: number }) {
    super();
    this.sampleRate = opts?.sampleRate && opts.sampleRate > 0 ? opts.sampleRate : DEFAULT_REALTIME_PROVIDER_RATE;
    this.sipSampleRate =
      opts?.sipSampleRate && opts.sipSampleRate > 0 ? opts.sipSampleRate : SIP_PCM_RATE;
  }

  abstract connect(options?: RealtimeSessionOptions): Promise<void>;
  abstract sendToolResult(callId: string, output: string): Promise<void>;
  protected abstract sendProviderPcm(pcmProvider: Buffer): void | Promise<void>;
  protected abstract disconnect(): Promise<void>;

  setUplinkMuted(muted: boolean): void {
    this.uplinkMuted = muted;
  }

  isUplinkMuted(): boolean {
    return this.uplinkMuted;
  }

  async sendPcm(pcmSip: Buffer): Promise<void> {
    if (this.closed || !this.ready || this.uplinkMuted || !pcmSip.length) return;
    const pcm = sipPcmToProvider(pcmSip, this.sampleRate, this.sipSampleRate);
    await this.sendProviderPcm(pcm);
  }

  /**
   * Downlink path for subclasses: provider PCM → SIP rate → `audio` event.
   * Emits `ttfa` once on first non-empty chunk.
   */
  protected emitDownlinkPcm(pcmProvider: Buffer): void {
    if (this.closed || !pcmProvider.length) return;
    if (!this.ttfaEmitted && this.connectedAt > 0) {
      this.ttfaEmitted = true;
      this.emit("ttfa", Math.max(0, Math.round(performance.now() - this.connectedAt)));
    }
    const pcmSip = providerPcmToSip(pcmProvider, this.sampleRate, this.sipSampleRate);
    if (pcmSip.length) this.emit("audio", pcmSip);
  }

  /** Subclasses call after session.update is accepted. */
  protected markReady(): void {
    if (this.closed || this.ready) return;
    this.ready = true;
    this.connectedAt = performance.now();
    this.emit("ready");
  }

  /** Subclasses forward parsed function_call events. */
  protected emitToolCall(call: RealtimeToolCall): void {
    if (this.closed) return;
    this.emit("tool_call", call);
  }

  protected emitProviderError(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    this.emit("error", error);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    try {
      await this.disconnect();
    } catch (err) {
      this.emitProviderError(err);
    } finally {
      this.emit("closed");
      this.removeAllListeners();
    }
  }
}
