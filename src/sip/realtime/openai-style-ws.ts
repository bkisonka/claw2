// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Shared WebSocket Realtime adapter for OpenAI-compatible event streams
 * (OpenAI, Yandex Speech Realtime, xAI Grok Voice).
 */
import { WebSocket } from "undici";
import { BaseRealtimeProvider } from "./base.js";
import { DEFAULT_REALTIME_PROVIDER_RATE } from "./types.js";
import type { RealtimeSessionOptions, RealtimeToolCall } from "./types.js";

type PendingFn = { name: string; arguments: string };

export interface OpenAiStyleRealtimeOptions {
  model?: string;
  voice?: string;
  baseURL?: string;
  sampleRate?: number;
  sipSampleRate?: number;
  silenceDurationMs?: number;
  vadThreshold?: number;
  /** Send response.create after session.update. Default true. */
  createResponseOnConnect?: boolean;
  callId?: string;
}

function parseToolArguments(raw: unknown): Record<string, unknown> | string {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string") return {};
  const s = raw.trim();
  if (!s) return {};
  try {
    const parsed = JSON.parse(s) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return s;
  } catch {
    return s;
  }
}

function isIgnorableProtocolError(msg: string): boolean {
  return (
    msg.includes("CancelResponse") ||
    msg.includes("USER_SPEAKING") ||
    msg.includes("WAITING_FOR_TOOL_RESULT") ||
    msg.includes("FinalizeUserUtterance")
  );
}

export abstract class OpenAiStyleRealtimeProvider extends BaseRealtimeProvider {
  protected readonly defaultModel?: string;
  protected readonly defaultVoice: string;
  protected readonly baseURL: string;
  protected readonly silenceDurationMs: number;
  protected readonly vadThreshold: number;
  protected readonly createResponseOnConnect: boolean;
  protected readonly callId: string;

  private ws: WebSocket | null = null;
  private pendingFn = new Map<string, PendingFn>();
  private toolWaitIds = new Set<string>();
  private handledFps = new Set<string>();
  private sessionCreated = false;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: OpenAiStyleRealtimeOptions & { defaultVoice: string; baseURL: string }) {
    super({
      sampleRate: opts.sampleRate ?? DEFAULT_REALTIME_PROVIDER_RATE,
      sipSampleRate: opts.sipSampleRate,
    });
    this.defaultModel = opts.model?.trim() || undefined;
    this.defaultVoice = opts.voice?.trim() || opts.defaultVoice;
    this.baseURL = opts.baseURL.replace(/\/$/, "");
    this.silenceDurationMs = opts.silenceDurationMs ?? 800;
    this.vadThreshold = opts.vadThreshold ?? 0.5;
    this.createResponseOnConnect = opts.createResponseOnConnect !== false;
    this.callId = opts.callId?.trim() || "";

    this.on("ttfa", (ms) => {
      console.info(`[${this.logTag()}] realtime_ttfa_ms`, {
        ms,
        callId: this.callId || undefined,
        provider: this.id,
      });
    });
  }

  protected abstract logTag(): string;
  protected abstract buildAuthHeaders(): Record<string, string>;
  /** Full WS URL including model query when required. */
  protected abstract buildConnectUrl(model: string): string;

  /** Nested session.update body (GA OpenAI / Yandex style). */
  protected buildSessionUpdateBody(session: {
    instructions: string;
    tools: RealtimeSessionOptions["tools"];
    voice: string;
    providerRate: number;
    model: string;
  }): Record<string, unknown> {
    return {
      type: "realtime",
      model: session.model,
      output_modalities: ["audio"],
      instructions: session.instructions || undefined,
      tools: session.tools ?? [],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: session.providerRate },
          turn_detection: {
            type: "server_vad",
            create_response: true,
            silence_duration_ms: this.silenceDurationMs,
            threshold: this.vadThreshold,
          },
        },
        output: {
          voice: session.voice,
          format: { type: "audio/pcm", rate: session.providerRate },
        },
      },
    };
  }

  async connect(options: RealtimeSessionOptions = {}): Promise<void> {
    if (this.closed) throw new Error(`${this.logTag()}: already closed`);
    if (this.ws) throw new Error(`${this.logTag()}: already connected`);

    const model = (options.model?.trim() || this.defaultModel || "").trim();
    if (!model) throw new Error(`${this.logTag()}: model is required`);

    const url = this.buildConnectUrl(model);
    const headers = this.buildAuthHeaders();
    const voice = options.voice?.trim() || this.defaultVoice;
    const providerRate =
      options.sampleRate && options.sampleRate > 0 ? options.sampleRate : this.sampleRate;

    let instructions = options.instructions?.trim() || "";
    if (options.greeting?.trim()) {
      instructions = instructions
        ? `${instructions}\n\nAt the beginning of the conversation, say hello something like this: “${options.greeting.trim()}».`
        : `At the beginning of the conversation, say hello something like this: “${options.greeting.trim()}».`;
    }

    await new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.connectTimer = setTimeout(() => {
        reject(new Error(`${this.logTag()}: connect timeout waiting for session`));
        void this.disconnect();
      }, 20_000);

      try {
        this.ws = new WebSocket(url, { headers });
      } catch (err) {
        this.clearConnectWait();
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      this.ws.addEventListener("open", () => {
        this.log("realtime_ws_open", { model });
      });

      this.ws.addEventListener("message", (ev) => {
        void this.onMessage(ev.data, {
          instructions,
          tools: options.tools ?? [],
          voice,
          providerRate,
          model,
        });
      });

      this.ws.addEventListener("error", () => {
        const err = new Error(`${this.logTag()}: WebSocket error`);
        this.emitProviderError(err);
        if (this.connectReject) {
          this.clearConnectWait();
          reject(err);
        }
      });

      this.ws.addEventListener("close", (ev) => {
        this.log("realtime_ws_closed", {
          code: ev.code,
          reason: String(ev.reason || "").slice(0, 200),
        });
        this.ws = null;
        this.ready = false;
        if (this.connectReject) {
          const err = new Error(`${this.logTag()}: WebSocket closed before ready (code ${ev.code})`);
          this.clearConnectWait();
          reject(err);
        } else if (!this.closed) {
          void this.close();
        }
      });
    });
  }

  async sendToolResult(callId: string, output: string): Promise<void> {
    const cid = callId.trim();
    if (!cid) return;
    await this.sendJson({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: cid,
        output: output ?? "",
      },
    });
    await this.sendJson({ type: "response.create" });
    this.endToolWait(cid);
  }

  protected async sendProviderPcm(pcmProvider: Buffer): Promise<void> {
    if (!pcmProvider.length || this.toolWaitIds.size > 0) return;
    const audio = pcmProvider.toString("base64");
    await this.sendJson({ type: "input_audio_buffer.append", audio });
  }

  protected async disconnect(): Promise<void> {
    this.clearConnectWait();
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, "client_close");
      }
    } catch {
      /* ignore */
    }
  }

  private clearConnectWait(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.connectResolve = null;
    this.connectReject = null;
  }

  private async onMessage(
    data: unknown,
    session: {
      instructions: string;
      tools: RealtimeSessionOptions["tools"];
      voice: string;
      providerRate: number;
      model: string;
    }
  ): Promise<void> {
    const text =
      typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : data instanceof ArrayBuffer
            ? Buffer.from(data).toString("utf8")
            : "";
    if (!text) return;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    const et = String(event.type || "");
    if (et === "session.created") {
      this.sessionCreated = true;
      await this.sendSessionUpdate(session);
      return;
    }

    if (et === "session.updated") {
      if (!this.ready) {
        this.markReady();
        const resolve = this.connectResolve;
        this.clearConnectWait();
        resolve?.();
        if (this.createResponseOnConnect) {
          await this.sendJson({ type: "response.create" });
        }
      }
      return;
    }

    if (et === "error") {
      const errObj =
        event.error && typeof event.error === "object" ? (event.error as Record<string, unknown>) : {};
      const msg = String(errObj.message || JSON.stringify(event));
      if (isIgnorableProtocolError(msg)) {
        console.warn(`[${this.logTag()}] realtime warn (ignored): ${msg.slice(0, 240)}`);
        return;
      }
      this.emitProviderError(new Error(`${this.logTag()}: ${msg}`));
      return;
    }

    if (et === "response.output_audio.delta" || et === "response.audio.delta") {
      const delta = String(event.delta || "");
      if (!delta) return;
      try {
        this.emitDownlinkPcm(Buffer.from(delta, "base64"));
      } catch (err) {
        this.emitProviderError(err);
      }
      return;
    }

    if (et === "response.output_item.added") {
      const item = event.item && typeof event.item === "object" ? (event.item as Record<string, unknown>) : null;
      if (item?.type === "function_call") {
        const callId = String(item.call_id || item.id || "");
        if (callId) this.beginToolWait(callId);
      }
      return;
    }

    if (et === "response.function_call_arguments.delta") {
      const callId = String(event.call_id || "");
      if (!callId) return;
      this.beginToolWait(callId);
      const slot = this.pendingFn.get(callId) ?? { name: "", arguments: "" };
      if (event.name) slot.name = String(event.name);
      slot.arguments += String(event.delta || "");
      this.pendingFn.set(callId, slot);
      return;
    }

    if (et === "response.function_call_arguments.done") {
      this.handleFunctionCallDone(event);
      return;
    }

    if (et === "response.output_item.done") {
      const item = event.item && typeof event.item === "object" ? (event.item as Record<string, unknown>) : null;
      if (item?.type === "function_call") {
        this.handleFunctionCallDone({
          call_id: item.call_id || item.id,
          name: item.name,
          arguments: item.arguments,
        });
      }
    }
  }

  private async sendSessionUpdate(session: {
    instructions: string;
    tools: RealtimeSessionOptions["tools"];
    voice: string;
    providerRate: number;
    model: string;
  }): Promise<void> {
    if (!this.sessionCreated) return;
    await this.sendJson({
      type: "session.update",
      session: this.buildSessionUpdateBody(session),
    });
  }

  private handleFunctionCallDone(event: Record<string, unknown>): void {
    const callId = String(event.call_id || "").trim();
    if (!callId) return;
    this.beginToolWait(callId);

    let name = String(event.name || "").trim();
    let argsRaw: unknown = event.arguments;
    const pending = this.pendingFn.get(callId);
    if (pending) {
      this.pendingFn.delete(callId);
      if (!name) name = pending.name.trim();
      if (argsRaw == null || argsRaw === "") argsRaw = pending.arguments;
    }
    if (!name) {
      this.endToolWait(callId);
      return;
    }

    const args = parseToolArguments(argsRaw);
    const fp = `${name}:${typeof args === "string" ? args : JSON.stringify(args)}`;
    if (this.handledFps.has(fp)) {
      this.endToolWait(callId);
      return;
    }
    this.handledFps.add(fp);

    const call: RealtimeToolCall = { callId, name, arguments: args };
    this.emitToolCall(call);
  }

  private beginToolWait(callId: string): void {
    const cid = callId.trim();
    if (!cid) return;
    this.toolWaitIds.add(cid);
    this.setUplinkMuted(true);
  }

  private endToolWait(callId: string): void {
    const cid = callId.trim();
    if (cid) this.toolWaitIds.delete(cid);
    if (this.toolWaitIds.size === 0) this.setUplinkMuted(false);
  }

  private async sendJson(payload: Record<string, unknown>): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.closed) return;
    ws.send(JSON.stringify(payload));
  }

  protected log(event: string, fields?: Record<string, unknown>): void {
    console.info(`[${this.logTag()}] ${event}`, {
      callId: this.callId || undefined,
      ...fields,
    });
  }
}
