// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Contract for Realtime speech-to-speech adapters on a SIP call.
 *
 * Media path: SIP dialog PCM @ 8 kHz ↔ adapter (resample) ↔ provider WS.
 * Tools: session.update schemas → on("tool_call") → sendToolResult.
 */
import type { RealtimeProviderId, RealtimeSessionOptions, RealtimeToolCall } from "./types.js";

export interface RealtimeProvider {
  readonly id: RealtimeProviderId;
  /** Provider-side PCM sample rate (Hz). */
  readonly sampleRate: number;
  /** SIP-side PCM sample rate (Hz), usually 8000. */
  readonly sipSampleRate: number;

  /** Open WS / session; emit `ready` when session.update is accepted. */
  connect(options?: RealtimeSessionOptions): Promise<void>;

  /**
   * Uplink: PCM16 mono at {@link sipSampleRate}.
   * Adapter resamples to {@link sampleRate} before sending.
   * No-op while uplink is muted or session is not ready.
   */
  sendPcm(pcmSip: Buffer): void | Promise<void>;

  /**
   * Mute uplink (e.g. while executing a tool — avoids barge echo).
   * When muted, sendPcm discards frames.
   */
  setUplinkMuted(muted: boolean): void;

  /** Whether uplink is currently muted. */
  isUplinkMuted(): boolean;

  /** Push tool result back into the Realtime session. */
  sendToolResult(callId: string, output: string): Promise<void>;

  /** Tear down WS / timers; emit `closed`. Idempotent. */
  close(): Promise<void>;

  on(event: "audio", listener: (pcmSip: Buffer) => void): this;
  on(event: "tool_call", listener: (call: RealtimeToolCall) => void): this;
  on(event: "ready", listener: () => void): this;
  on(event: "closed", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "ttfa", listener: (ms: number) => void): this;

  off(event: "audio", listener: (pcmSip: Buffer) => void): this;
  off(event: "tool_call", listener: (call: RealtimeToolCall) => void): this;
  off(event: "ready", listener: () => void): this;
  off(event: "closed", listener: () => void): this;
  off(event: "error", listener: (err: Error) => void): this;
  off(event: "ttfa", listener: (ms: number) => void): this;
}
