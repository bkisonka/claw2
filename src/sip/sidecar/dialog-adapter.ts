// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Adapt SipSidecarRuntime call to DialogLike used by SipClient.
 */
import type { SidecarMediaPort } from "./media-port.js";
import type { SipSidecarRuntime } from "./runtime.js";

type DialogLike = {
  callId?: string | null;
  bye: () => Promise<unknown>;
  accept: (opts?: { payloadType?: number }) => Promise<DialogLike>;
  trying: () => Promise<void>;
  ringing: () => Promise<void>;
  reject: (status?: number, reason?: string) => Promise<void>;
  sendAudioPaced: (pcm: Buffer) => Promise<void>;
  sendDtmf: (digit: string, duration?: number) => void;
  refer: (targetUri: string) => Promise<unknown>;
  on: (event: string, listener: (...args: unknown[]) => void) => DialogLike;
  once: (event: string, listener: (...args: unknown[]) => void) => DialogLike;
};

type Listener = (...args: unknown[]) => void;

export function createSidecarDialogAdapter(
  runtime: SipSidecarRuntime,
  callId: string,
  media: SidecarMediaPort
): DialogLike {
  const listeners = new Map<string, Set<Listener>>();
  const onceListeners = new Map<string, Set<Listener>>();

  const emit = (event: string, ...args: unknown[]) => {
    for (const fn of listeners.get(event) ?? []) {
      try {
        fn(...args);
      } catch (err) {
        console.error("[sip/sidecar] dialog listener error:", err);
      }
    }
    const once = onceListeners.get(event);
    if (once) {
      onceListeners.delete(event);
      for (const fn of once) {
        try {
          fn(...args);
        } catch (err) {
          console.error("[sip/sidecar] dialog once error:", err);
        }
      }
    }
  };

  media.on("audio", (pcm: Buffer) => emit("audio", pcm));

  const onEnded = (endedId: string) => {
    if (endedId === callId) emit("end");
  };
  runtime.on("call_ended", onEnded);

  const self: DialogLike = {
    callId,
    async trying() {},
    async ringing() {},
    async accept() {
      runtime.answer(callId);
      emit("ready");
      return self;
    },
    async reject() {
      runtime.deny(callId);
      emit("end");
    },
    async bye() {
      runtime.hangup(callId);
      emit("end");
    },
    async sendAudioPaced(pcm: Buffer) {
      media.playPcm(pcm, { finalize: false });
    },
    sendDtmf() {
      console.error("[sip/sidecar] DTMF not supported via SMED v1");
    },
    async refer(targetUri: string) {
      runtime.transfer(callId, targetUri);
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return self;
    },
    once(event, listener) {
      if (!onceListeners.has(event)) onceListeners.set(event, new Set());
      onceListeners.get(event)!.add(listener);
      return self;
    },
  };

  return self;
}
