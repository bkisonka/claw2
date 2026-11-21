// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * SIP UA: REGISTER to virtual PBX + outgoing/incoming calls (RTP PCM).
 * Stack: @vexyl.ai/sip (without native deps).
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";
import type { Claw2Config } from "../config/types.js";
import {
  isPhoneCallToolEnabled,
  isSipRealtimeEnabled,
  resolveSipAutoAnswer,
  resolveSipDisplayName,
  resolveSipDomain,
  resolveSipLocalPort,
  resolveSipOperatorUri,
  resolveSipPassword,
  resolveSipPort,
  resolveSipPublicAddress,
  resolveSipRealtimeProvider,
  resolveSipRegisterExpires,
  resolveSipServer,
  resolveSipUser,
} from "../config/sip.js";
import { synthesizeSipPcm, transcribeSipPcm } from "./voice-bridge.js";
import {
  appendCallLogEvent,
  finishCallLog,
  startCallLog,
} from "./call-log.js";
import {
  observeCallStart,
  observeRealtimeFallback,
  observeRealtimeStarted,
  observeRealtimeTtfa,
} from "./call-observability.js";
import {
  createRealtimeProviderFromConfig,
  getRealtimeToolDefinitions,
  wireRealtimeTools,
  type RealtimeProvider,
} from "./realtime/index.js";
import { resolveSipMediaBackend } from "./media-backend.js";
import {
  createSidecarDialogAdapter,
  tryStartSipSidecar,
  type SipSidecarRuntime,
} from "./sidecar/index.js";
import type { SidecarIncomingInfo } from "./sidecar/index.js";
import { buildOutboundDialTarget, normalizeTargetUri } from "./dial-uri.js";
import { sipUaFingerprint } from "./ua-fingerprint.js";

const require = createRequire(import.meta.url);
const { SipStack } = require("@vexyl.ai/sip/stack") as {
  SipStack: new (opts?: Record<string, unknown>) => SipStackLike;
};
const digest = require("@vexyl.ai/sip/digest") as {
  signRequest: (ctx: object, rq: SipMsg, rs: SipMsg, creds: { user: string; password: string }) => unknown;
};
const sipCore = require("@vexyl.ai/sip") as {
  generateTag: () => string;
  stringifyUri: (uri: string | SipUri) => string;
  parseUri: (uri: string) => SipUri | undefined;
};

type SipUri = { schema?: string; user?: string; host: string; port?: number; params?: Record<string, string | undefined> };
type SipMsg = {
  method?: string;
  status?: number;
  reason?: string;
  uri?: string | SipUri;
  headers: Record<string, unknown>;
  content?: string;
};

type DialogLike = {
  callId?: string | null;
  /** Present on @vexyl.ai/sip Dialog: init|trying|ringing|active|held|ended */
  state?: string;
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

type SipStackLike = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  call: (uri: string, options?: Record<string, unknown>) => Promise<DialogLike>;
  send: (message: SipMsg, callback?: (rs: SipMsg) => void) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => SipStackLike;
  getStats: () => { active: boolean; dialogs: number };
};

export type SipCallState = "idle" | "ringing" | "connecting" | "active" | "ended";

export type SipStatus = {
  enabled: boolean;
  running: boolean;
  registered: boolean;
  registerError?: string;
  server?: string;
  domain?: string;
  user?: string;
  aor?: string;
  /** Effective RTP/SIP media path after resolve + sidecar health. */
  mediaBackend?: {
    requested: "auto" | "node" | "sidecar";
    effective: "node" | "sidecar";
    sidecarPath?: string;
    reason: string;
    status: "running" | "not_found" | "fallback" | "node";
  };
  call?: {
    id: string;
    state: SipCallState;
    remote?: string;
    direction: "out" | "in";
    /** Active speech-to-speech Realtime provider, if any. */
    realtime?: "yandex" | "openai" | "xai";
  };
};

type ActiveCall = {
  id: string;
  logId: string;
  dialog: DialogLike;
  state: SipCallState;
  remote: string;
  direction: "out" | "in";
  pcmChunks: Buffer[];
  recording: boolean;
  /** Duplex Realtime session (null/undefined = pipeline listen/say). */
  realtime?: RealtimeProvider | null;
  /** Serializes downlink sendAudioPaced to avoid overlapping RTP. */
  realtimePlayQueue?: Promise<void>;
};

function guessLocalIpv4(): string {
  const nets = networkInterfaces();
  for (const addrs of Object.values(nets)) {
    for (const a of addrs ?? []) {
      const family = a.family === "IPv4" || (a.family as unknown) === 4;
      if (family && !a.internal) return a.address;
    }
  }
  return "127.0.0.1";
}

function sendAndWait(stack: SipStackLike, rq: SipMsg, timeoutMs = 15_000): Promise<SipMsg> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("SIP request timeout")), timeoutMs);
    stack.send(rq, (rs) => {
      clearTimeout(t);
      resolve(rs);
    });
  });
}

class SipClient {
  private config: Claw2Config | null = null;
  private stack: SipStackLike | null = null;
  private registered = false;
  private registerError: string | undefined;
  private registerTimer: ReturnType<typeof setTimeout> | null = null;
  private cseq = 1;
  private callId = randomUUID();
  private fromTag = sipCore.generateTag();
  private digestCtx: object = {};
  private active: ActiveCall | null = null;
  private pendingIncoming: ActiveCall | null = null;
  private starting = false;
  /** When set, SIP UA is native sidecar (Node stack not started). */
  private sidecar: SipSidecarRuntime | null = null;
  private mediaBackendEffective: "node" | "sidecar" = "node";
  /** Fingerprint of the running UA; skip stop/start when unchanged. */
  private runningFingerprint: string | null = null;

  getStatus(): SipStatus {
    const cfg = this.config;
    const enabled = cfg ? isPhoneCallToolEnabled(cfg) : false;
    const user = cfg ? resolveSipUser(cfg) : "";
    const domain = cfg ? resolveSipDomain(cfg) : "";
    const call = this.active
      ? {
          id: this.active.id,
          state: this.active.state,
          remote: this.active.remote,
          direction: this.active.direction,
          ...(this.active.realtime ? { realtime: this.active.realtime.id } : {}),
        }
      : this.pendingIncoming
        ? {
            id: this.pendingIncoming.id,
            state: this.pendingIncoming.state,
            remote: this.pendingIncoming.remote,
            direction: this.pendingIncoming.direction,
          }
        : undefined;
    return {
      enabled,
      running: !!(this.stack || this.sidecar),
      registered: this.registered,
      registerError: this.registerError,
      server: cfg ? resolveSipServer(cfg) : undefined,
      domain: domain || undefined,
      user: user || undefined,
      aor: user && domain ? `sip:${user}@${domain}` : undefined,
      mediaBackend: cfg
        ? (() => {
            const resolved = resolveSipMediaBackend(cfg);
            const effective = this.mediaBackendEffective;
            let status: "running" | "not_found" | "fallback" | "node" = "node";
            if (effective === "sidecar" && this.sidecar?.isHealthy) status = "running";
            else if (resolved.requested === "sidecar" || resolved.requested === "auto") {
              if (resolved.backend === "node" && !resolved.sidecarPath) status = "not_found";
              else if (effective === "node") status = "fallback";
              else status = "node";
            }
            return {
              requested: resolved.requested,
              effective,
              sidecarPath: resolved.sidecarPath,
              reason: resolved.reason,
              status,
            };
          })()
        : undefined,
      call,
    };
  }

  async sync(config: Claw2Config): Promise<void> {
    if (!isPhoneCallToolEnabled(config)) {
      this.config = config;
      await this.stop();
      return;
    }

    const nextFp = sipUaFingerprint(config);
    const uaUp = !!(this.stack || this.sidecar);

    // Every phone_call used to call start()→stop() and BYE the live call.
    if (uaUp && this.runningFingerprint === nextFp) {
      this.config = config;
      return;
    }

    if (uaUp && (this.active || this.pendingIncoming)) {
      // Keep the call; apply non-UA config (voice/realtime keys etc.) without teardown.
      this.config = config;
      console.error(
        "[sip] sync: SIP identity changed during an active call — deferring UA restart until hangup",
      );
      return;
    }

    this.config = config;
    await this.start(config);
  }

  async start(config: Claw2Config): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    try {
      await this.stop();
      this.config = config;
      if (!isPhoneCallToolEnabled(config)) return;

      const media = resolveSipMediaBackend(config);
      console.error(`[sip] mediaBackend requested=${media.requested} → ${media.backend} (${media.reason})`);

      if (media.backend === "sidecar") {
        const result = await tryStartSipSidecar(config);
        if (result.ok) {
          this.sidecar = result.runtime;
          this.mediaBackendEffective = "sidecar";
          this.registered = true;
          this.registerError = undefined;
          this.runningFingerprint = sipUaFingerprint(config);
          this.wireSidecarEvents();
          console.error("[sip] UA = sip-media-sidecar (Node stack skipped)");
          return;
        }
        console.error(`[sip] sidecar unavailable, using node: ${result.reason}`);
      }

      this.mediaBackendEffective = "node";
      const server = resolveSipServer(config);
      const user = resolveSipUser(config);
      const password = resolveSipPassword(config);
      const localPort = resolveSipLocalPort(config);
      const publicAddress = resolveSipPublicAddress(config) || guessLocalIpv4();
      const remotePort = resolveSipPort(config);

      this.stack = new SipStack({
        port: localPort,
        publicAddress,
        address: "0.0.0.0",
        udp: true,
        tcp: false,
        credentials: { user, password },
        maxConcurrentCalls: 1,
        keepaliveTargets: [{ uri: `sip:${server}${remotePort !== 5060 ? `:${remotePort}` : ""}`, interval: 30_000 }],
        logger: {
          error: (...args: unknown[]) => console.error("[sip]", ...args),
          info: (...args: unknown[]) => console.error("[sip]", ...args),
        },
      });

      this.stack.on("invite", (dialog) => {
        void this.onIncoming(dialog as DialogLike);
      });
      this.stack.on("error", (err) => {
        console.error("[sip] stack error:", err);
      });

      await this.stack.start();
      console.error(`[sip] UA listening UDP :${localPort} contact=${publicAddress}`);

      this.callId = randomUUID();
      this.fromTag = sipCore.generateTag();
      this.digestCtx = {};
      this.cseq = 1;
      await this.registerOnce(true);
      this.scheduleReregister();
      this.runningFingerprint = sipUaFingerprint(config);
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    if (this.registerTimer) {
      clearTimeout(this.registerTimer);
      this.registerTimer = null;
    }
    if (this.active) {
      await this.stopRealtime(this.active);
      try {
        await this.active.dialog.bye();
      } catch {
        /* ignore */
      }
      this.active = null;
    }
    if (this.pendingIncoming) {
      try {
        await this.pendingIncoming.dialog.reject(486, "Busy Here");
      } catch {
        /* ignore */
      }
      this.pendingIncoming = null;
    }
    if (this.sidecar) {
      try {
        await this.sidecar.stop();
      } catch (err) {
        console.error("[sip] sidecar stop failed:", err);
      }
      this.sidecar = null;
    }
    if (this.stack) {
      try {
        if (this.registered && this.config && this.mediaBackendEffective === "node") {
          await this.registerOnce(false).catch(() => undefined);
        }
      } catch {
        /* ignore */
      }
      try {
        await this.stack.stop();
      } catch (err) {
        console.error("[sip] stop failed:", err);
      }
      this.stack = null;
    }
    this.runningFingerprint = null;
    this.mediaBackendEffective = "node";
    this.registered = false;
  }

  private wireSidecarEvents(): void {
    const runtime = this.sidecar;
    if (!runtime) return;
    runtime.on("incoming", (info: SidecarIncomingInfo) => {
      void this.onSidecarIncoming(info);
    });
    runtime.on("error", (err: Error) => {
      console.error("[sip] sidecar error:", err.message);
      this.registerError = err.message;
    });
    runtime.on("disconnected", () => {
      this.registered = false;
      this.registerError = "sidecar disconnected";
      console.error("[sip] sidecar disconnected");
    });
  }

  private async onSidecarIncoming(info: SidecarIncomingInfo): Promise<void> {
    if (!this.sidecar || !this.config) return;
    const remoteStr = info.caller || "unknown";
    const log = startCallLog({ direction: "in", remote: remoteStr, id: info.callId });
    const media = this.sidecar.ensureMedia(info.callId);
    const dialog = createSidecarDialogAdapter(this.sidecar, info.callId, media);

    const call: ActiveCall = {
      id: info.callId,
      logId: log.id,
      dialog,
      state: "ringing",
      remote: remoteStr,
      direction: "in",
      pcmChunks: [],
      recording: false,
    };

    dialog.on("audio", (pcm) => {
      this.onDialogAudio(call, pcm);
    });
    dialog.on("end", () => {
      call.state = "ended";
      void this.stopRealtime(call);
      finishCallLog(call.logId);
      if (this.active?.id === call.id) this.active = null;
      if (this.pendingIncoming?.id === call.id) this.pendingIncoming = null;
    });

    if (resolveSipAutoAnswer(this.config)) {
      if (this.active) {
        await dialog.reject(486, "Busy Here");
        finishCallLog(call.logId, { failed: true, detail: "busy" });
        return;
      }
      await dialog.accept({ payloadType: 0 });
      call.state = "active";
      this.active = call;
      appendCallLogEvent(call.logId, { type: "answer", detail: "auto" });
      appendCallLogEvent(call.logId, { type: "connected" });
      observeCallStart(this.config, { callId: call.id, logId: call.logId, direction: call.direction }, {
        mediaEffective: this.mediaBackendEffective,
      });
      console.error(`[sip] sidecar auto-answered ${remoteStr}`);
      await this.maybeStartRealtime(call);
      return;
    }

    if (this.pendingIncoming || this.active) {
      await dialog.reject(486, "Busy Here");
      finishCallLog(call.logId, { failed: true, detail: "busy" });
      return;
    }
    this.pendingIncoming = call;
    console.error(`[sip] sidecar incoming from ${remoteStr} — phone_call(action=answer)`);
  }

  private contactUri(): string {
    const cfg = this.config!;
    const user = resolveSipUser(cfg);
    const publicAddress = resolveSipPublicAddress(cfg) || guessLocalIpv4();
    const localPort = resolveSipLocalPort(cfg);
    return `sip:${user}@${publicAddress}:${localPort}`;
  }

  private aor(): string {
    const cfg = this.config!;
    return `sip:${resolveSipUser(cfg)}@${resolveSipDomain(cfg)}`;
  }

  private async registerOnce(bind: boolean): Promise<void> {
    if (!this.stack || !this.config) return;
    const cfg = this.config;
    const server = resolveSipServer(cfg);
    const domain = resolveSipDomain(cfg);
    const user = resolveSipUser(cfg);
    const password = resolveSipPassword(cfg);
    const remotePort = resolveSipPort(cfg);
    const expires = bind ? resolveSipRegisterExpires(cfg) : 0;
    const displayName = resolveSipDisplayName(cfg);
    const registrarUri = remotePort === 5060 ? `sip:${server}` : `sip:${server}:${remotePort}`;

    const makeRq = (): SipMsg => ({
      method: "REGISTER",
      uri: registrarUri,
      headers: {
        to: { name: displayName, uri: this.aor() },
        from: { name: displayName, uri: this.aor(), params: { tag: this.fromTag } },
        "call-id": this.callId,
        cseq: { method: "REGISTER", seq: this.cseq++ },
        contact: [{ uri: this.contactUri() }],
        expires,
        "max-forwards": 70,
        "user-agent": "claw2-sip/0.1",
      },
    });

    let rq = makeRq();
    let rs = await sendAndWait(this.stack, rq);
    if (rs.status === 401 || rs.status === 407) {
      digest.signRequest(this.digestCtx, rq, rs, { user, password });
      // cseq must bump on auth retry
      (rq.headers.cseq as { seq: number }).seq = this.cseq++;
      rs = await sendAndWait(this.stack, rq);
    }

    if (rs.status !== undefined && rs.status >= 200 && rs.status < 300) {
      this.registered = bind;
      this.registerError = undefined;
      console.error(`[sip] REGISTER ${bind ? "OK" : "unbind"} ${user}@${domain}`);
      return;
    }

    this.registered = false;
    this.registerError = `REGISTER ${rs.status ?? "?"} ${rs.reason ?? ""}`.trim();
    console.error(`[sip] ${this.registerError}`);
    if (bind) throw new Error(this.registerError);
  }

  private scheduleReregister(): void {
    if (this.registerTimer) clearTimeout(this.registerTimer);
    if (!this.config) return;
    const expires = resolveSipRegisterExpires(this.config);
    const delay = Math.max(30_000, (expires - 30) * 1000);
    this.registerTimer = setTimeout(() => {
      void this.registerOnce(true)
        .then(() => this.scheduleReregister())
        .catch((err) => {
          this.registerError = err instanceof Error ? err.message : String(err);
          this.scheduleReregister();
        });
    }, delay);
  }

  private async onIncoming(dialog: DialogLike): Promise<void> {
    const remote =
      (dialog as { request?: { headers?: { from?: { uri?: string } } } }).request?.headers?.from?.uri ||
      "unknown";
    const remoteStr = typeof remote === "string" ? remote : sipCore.stringifyUri(remote as SipUri);

    try {
      await dialog.trying();
      await dialog.ringing();
    } catch (err) {
      console.error("[sip] incoming trying/ringing failed:", err);
    }

    const callId = (dialog.callId as string) || randomUUID();
    const log = startCallLog({ direction: "in", remote: remoteStr, id: callId });

    const call: ActiveCall = {
      id: callId,
      logId: log.id,
      dialog,
      state: "ringing",
      remote: remoteStr,
      direction: "in",
      pcmChunks: [],
      recording: false,
    };

    dialog.on("audio", (pcm) => {
      this.onDialogAudio(call, pcm);
    });
    dialog.on("end", () => {
      call.state = "ended";
      void this.stopRealtime(call);
      finishCallLog(call.logId);
      if (this.active?.id === call.id) this.active = null;
      if (this.pendingIncoming?.id === call.id) this.pendingIncoming = null;
    });

    if (this.config && resolveSipAutoAnswer(this.config)) {
      if (this.active) {
        await dialog.reject(486, "Busy Here");
        finishCallLog(call.logId, { failed: true, detail: "busy" });
        return;
      }
      await dialog.accept({ payloadType: 0 });
      call.state = "active";
      this.active = call;
      appendCallLogEvent(call.logId, { type: "answer", detail: "auto" });
      appendCallLogEvent(call.logId, { type: "connected" });
      observeCallStart(this.config, { callId: call.id, logId: call.logId, direction: call.direction }, {
        mediaEffective: this.mediaBackendEffective,
      });
      console.error(`[sip] auto-answered ${remoteStr}`);
      await this.maybeStartRealtime(call);
      return;
    }

    if (this.pendingIncoming || this.active) {
      await dialog.reject(486, "Busy Here");
      finishCallLog(call.logId, { failed: true, detail: "busy" });
      return;
    }
    this.pendingIncoming = call;
    console.error(`[sip] incoming ringing from ${remoteStr} — phone_call(action=answer)`);
  }

  async dial(to: string): Promise<SipStatus> {
    if (!this.config) throw new Error("SIP not started (enable sip in settings)");
    if (this.active) throw new Error("Already in a call — hangup first");
    if (this.pendingIncoming) throw new Error("Incoming call pending — answer or hangup first");

    const domain = resolveSipDomain(this.config);
    const server = resolveSipServer(this.config);
    const remotePort = resolveSipPort(this.config);
    // UDP-safe request URI via registrar; To stays on PBX domain AOR.
    const { requestUri, toUri } = buildOutboundDialTarget({
      to,
      domain,
      server,
      port: remotePort,
    });
    const user = resolveSipUser(this.config);
    const password = resolveSipPassword(this.config);
    const displayName = resolveSipDisplayName(this.config);
    const fromUri = this.aor();

    const log = startCallLog({ direction: "out", remote: toUri });
    console.error(`[sip] dial request=${requestUri} to=${toUri}`);

    if (this.sidecar) {
      let callId: string;
      try {
        const placed = await this.sidecar.dial(requestUri);
        callId = placed.callId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendCallLogEvent(log.id, { type: "error", text: msg });
        finishCallLog(log.id, { failed: true, detail: msg });
        throw err;
      }

      const media = this.sidecar.ensureMedia(callId);
      const dialog = createSidecarDialogAdapter(this.sidecar, callId, media);
      const call: ActiveCall = {
        id: callId || log.id,
        logId: log.id,
        dialog,
        state: "active",
        remote: toUri,
        direction: "out",
        pcmChunks: [],
        recording: false,
      };
      this.active = call;
      dialog.on("audio", (pcm) => {
        this.onDialogAudio(call, pcm);
      });
      dialog.on("end", () => {
        call.state = "ended";
        void this.stopRealtime(call);
        finishCallLog(call.logId);
        if (this.active?.id === call.id) this.active = null;
      });
      appendCallLogEvent(call.logId, { type: "connected" });
      console.error(`[sip] dial connected (sidecar) id=${call.id} remote=${toUri}`);
      observeCallStart(this.config, { callId: call.id, logId: call.logId, direction: call.direction }, {
        mediaEffective: this.mediaBackendEffective,
      });
      try {
        await this.maybeStartRealtime(call);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[sip] realtime start failed after connect:", msg);
        appendCallLogEvent(call.logId, { type: "error", text: `realtime: ${msg}` });
      }
      return this.getStatus();
    }

    if (!this.stack) throw new Error("SIP not started (enable sip in settings)");

    let dialog: DialogLike;
    try {
      // SipStack.call resolves only after SIP 200 OK — it already emitted "ready".
      dialog = await this.stack.call(requestUri, {
        fromUri,
        credentials: { user, password },
        headers: {
          from: { name: displayName, uri: fromUri },
          to: { uri: toUri },
        },
        payloadType: 0,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendCallLogEvent(log.id, { type: "error", text: msg });
      finishCallLog(log.id, { failed: true, detail: msg });
      throw err;
    }

    const call: ActiveCall = {
      id: (dialog.callId as string) || log.id,
      logId: log.id,
      dialog,
      // Successful stack.call === established session (do not wait for "ready" again).
      state: dialog.state === "ended" ? "ended" : "active",
      remote: toUri,
      direction: "out",
      pcmChunks: [],
      recording: false,
    };
    this.active = call;

    dialog.on("audio", (pcm) => {
      this.onDialogAudio(call, pcm);
    });
    dialog.on("end", () => {
      call.state = "ended";
      void this.stopRealtime(call);
      finishCallLog(call.logId);
      if (this.active?.id === call.id) this.active = null;
    });

    if (call.state !== "active") {
      const msg = "Call ended before connect";
      appendCallLogEvent(call.logId, { type: "error", text: msg });
      finishCallLog(call.logId, { failed: true, detail: msg });
      this.active = null;
      throw new Error(msg);
    }

    appendCallLogEvent(call.logId, { type: "connected" });
    console.error(`[sip] dial connected id=${call.id} remote=${toUri}`);
    observeCallStart(this.config, { callId: call.id, logId: call.logId, direction: call.direction }, {
      mediaEffective: this.mediaBackendEffective,
    });
    try {
      await this.maybeStartRealtime(call);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[sip] realtime start failed after connect:", msg);
      appendCallLogEvent(call.logId, { type: "error", text: `realtime: ${msg}` });
      // Keep the SIP call active — connection status must stay truthful.
    }

    return this.getStatus();
  }

  async answer(): Promise<SipStatus> {
    const pending = this.pendingIncoming;
    if (!pending) throw new Error("No ringing incoming call");
    if (this.active) throw new Error("Already in a call");
    await pending.dialog.accept({ payloadType: 0 });
    pending.state = "active";
    this.active = pending;
    this.pendingIncoming = null;
    appendCallLogEvent(pending.logId, { type: "answer" });
    appendCallLogEvent(pending.logId, { type: "connected" });
    observeCallStart(this.config, { callId: pending.id, logId: pending.logId, direction: pending.direction }, {
      mediaEffective: this.mediaBackendEffective,
    });
    await this.maybeStartRealtime(pending);
    return this.getStatus();
  }

  async hangup(): Promise<SipStatus> {
    if (this.pendingIncoming) {
      const pending = this.pendingIncoming;
      try {
        await pending.dialog.reject(486, "Busy Here");
      } catch {
        try {
          await pending.dialog.bye();
        } catch {
          /* ignore */
        }
      }
      appendCallLogEvent(pending.logId, { type: "hangup", detail: "rejected" });
      finishCallLog(pending.logId);
      this.pendingIncoming = null;
      return this.getStatus();
    }
    if (!this.active) return this.getStatus();
    const call = this.active;
    await this.stopRealtime(call);
    try {
      await call.dialog.bye();
    } catch {
      /* ignore */
    }
    call.state = "ended";
    appendCallLogEvent(call.logId, { type: "hangup" });
    finishCallLog(call.logId);
    this.active = null;
    return this.getStatus();
  }

  async say(text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.active || this.active.state !== "active" || !this.config) {
      return { ok: false, error: "No active call" };
    }
    if (this.active.realtime) {
      return {
        ok: false,
        error: "Realtime mode active — say/listen are for pipeline (sip.realtime.provider=off)",
      };
    }
    try {
      const pcm = await synthesizeSipPcm(this.config, text);
      await this.active.dialog.sendAudioPaced(pcm);
      appendCallLogEvent(this.active.logId, { type: "say", text });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendCallLogEvent(this.active.logId, { type: "error", text: msg, detail: "say" });
      return { ok: false, error: msg };
    }
  }

  async listen(seconds: number): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    if (!this.active || this.active.state !== "active" || !this.config) {
      return { ok: false, error: "No active call" };
    }
    if (this.active.realtime) {
      return {
        ok: false,
        error: "Realtime mode active — say/listen are for pipeline (sip.realtime.provider=off)",
      };
    }
    const sec = Math.max(0.5, Math.min(30, seconds || 5));
    const call = this.active;
    call.pcmChunks = [];
    call.recording = true;
    await new Promise((r) => setTimeout(r, sec * 1000));
    call.recording = false;
    const pcm = Buffer.concat(call.pcmChunks);
    call.pcmChunks = [];
    try {
      const text = await transcribeSipPcm(this.config, pcm);
      appendCallLogEvent(call.logId, {
        type: "listen",
        text: text || undefined,
        detail: `${sec}s`,
      });
      return { ok: true, text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendCallLogEvent(call.logId, { type: "error", text: msg, detail: "listen" });
      return { ok: false, error: msg };
    }
  }

  async dtmf(digits: string): Promise<void> {
    if (!this.active || this.active.state !== "active") throw new Error("No active call");
    const clean = digits.replace(/[^0-9A-D*#]/gi, "");
    if (!clean) throw new Error("No DTMF digits");
    for (const d of clean) {
      this.active.dialog.sendDtmf(d);
      await new Promise((r) => setTimeout(r, 200));
    }
    appendCallLogEvent(this.active.logId, { type: "dtmf", text: clean });
  }

  async transfer(target?: string): Promise<void> {
    if (!this.active || this.active.state !== "active" || !this.config) {
      throw new Error("No active call");
    }
    const domain = resolveSipDomain(this.config);
    const raw = (target?.trim() || resolveSipOperatorUri(this.config)).trim();
    if (!raw) throw new Error("transfer target required (or sip.operatorUri)");
    const uri = normalizeTargetUri(raw, domain);
    await this.active.dialog.refer(uri);
    appendCallLogEvent(this.active.logId, { type: "transfer", detail: uri });
  }

  /**
   * Uplink: RTP PCM → Realtime (when session active) and/or listen recording buffer.
   * Barge-in: provider server_vad; uplink muted during tool wait inside adapters.
   */
  private onDialogAudio(call: ActiveCall, pcm: unknown): void {
    if (!Buffer.isBuffer(pcm) || !pcm.length) return;
    if (call.recording) call.pcmChunks.push(pcm);
    const rt = call.realtime;
    if (rt && call.state === "active") {
      void Promise.resolve(rt.sendPcm(pcm)).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[sip] realtime uplink failed:", msg);
      });
    }
  }

  /**
   * Start Realtime duplex when sip.realtime.provider is yandex|openai|xai.
   * On failure: leave call in pipeline mode (listen/say) and log error.
   */
  private async maybeStartRealtime(call: ActiveCall): Promise<void> {
    if (!this.config || call.state !== "active") return;
    if (!isSipRealtimeEnabled(this.config)) return;
    if (call.realtime) return;

    const providerName = resolveSipRealtimeProvider(this.config);
    try {
      const provider = createRealtimeProviderFromConfig(this.config, { callId: call.id });
      if (!provider) return;

      call.realtimePlayQueue = Promise.resolve();
      provider.on("audio", (pcmSip) => {
        if (this.active?.id !== call.id || call.state !== "active") return;
        const prev = call.realtimePlayQueue ?? Promise.resolve();
        call.realtimePlayQueue = prev
          .then(() => call.dialog.sendAudioPaced(pcmSip))
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[sip] realtime downlink failed:", msg);
          });
      });
      provider.on("error", (err) => {
        console.error(`[sip] realtime error (${provider.id}):`, err.message);
        appendCallLogEvent(call.logId, {
          type: "error",
          text: err.message,
          detail: `realtime:${provider.id}`,
        });
      });
      provider.on("ttfa", (ms) => {
        observeRealtimeTtfa(
          this.config,
          { callId: call.id, logId: call.logId, direction: call.direction },
          ms,
          provider.id
        );
      });
      provider.on("tool_call", (toolCall) => {
        appendCallLogEvent(call.logId, {
          type: "listen",
          text: toolCall.name,
          detail: "realtime_tool",
        });
      });
      wireRealtimeTools(provider, this.config, { callId: call.id });

      const tools = getRealtimeToolDefinitions(this.config);
      call.realtime = provider;
      try {
        await provider.connect({
          instructions:
            "You are a phone voice assistant for claw2. Speak briefly and clearly. " +
            "Prefer the caller's language. Do not invent facts; use tools when available. " +
            "For call control use phone_call (hangup, transfer, dtmf). Do not use say/listen.",
          tools,
        });
      } catch (err) {
        call.realtime = null;
        await provider.close().catch(() => undefined);
        throw err;
      }
      observeRealtimeStarted(
        this.config,
        { callId: call.id, logId: call.logId, direction: call.direction },
        provider.id
      );
      console.error(`[sip] realtime started provider=${provider.id} call=${call.id}`);
    } catch (err) {
      call.realtime = null;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sip] realtime start failed (${providerName}), staying on pipeline:`, msg);
      observeRealtimeFallback(
        this.config,
        { callId: call.id, logId: call.logId, direction: call.direction },
        providerName,
        msg
      );
    }
  }

  private async stopRealtime(call: ActiveCall): Promise<void> {
    const rt = call.realtime;
    call.realtime = null;
    call.realtimePlayQueue = undefined;
    if (!rt) return;
    try {
      await rt.close();
      console.error(`[sip] realtime closed provider=${rt.id} call=${call.id}`);
    } catch (err) {
      console.error("[sip] realtime close failed:", err);
    }
  }
}

const sipClient = new SipClient();

export function getSipClient(): SipClient {
  return sipClient;
}

export async function syncSipClient(config: Claw2Config): Promise<void> {
  await sipClient.sync(config);
}
