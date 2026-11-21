// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * PDOC v1 job client over Unix socket (POSIX) or named pipe (Windows).
 */
import { createConnection, type Socket } from "node:net";
import { PDOC_HEADER_SIZE, PdocIpcType, packPdocFrame, unpackPdocHeader } from "./protocol.js";

export type OcrWord = {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  conf: number;
  page?: number;
};

export type PaintBox = { page?: number; x: number; y: number; w: number; h: number };

export class PrivacyOcrClient {
  private sock: Socket | null = null;
  private readBuf = Buffer.alloc(0);
  private writeChain: Promise<void> = Promise.resolve();
  private ready = false;
  private pending:
    | {
        resolve: (v: { type: PdocIpcType; payload: Buffer }) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private blobAfterDone: Buffer | null = null;
  private waitingBlob = false;

  constructor(private readonly path: string) {}

  async connect(timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: Error | null = null;
    while (Date.now() < deadline) {
      try {
        await this.connectOnce(Math.min(2000, Math.max(200, deadline - Date.now())));
        const ready = await this.waitFrame(Math.max(500, deadline - Date.now()));
        if (ready.type !== PdocIpcType.Ready) {
          throw new Error("privacy-ocr: expected Ready");
        }
        this.ready = true;
        return;
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        try {
          this.sock?.destroy();
        } catch {
          /* */
        }
        this.sock = null;
        await new Promise((r) => setTimeout(r, 80));
      }
    }
    throw lastErr || new Error(`privacy-ocr connect timeout ${this.path}`);
  }

  private connectOnce(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sock = createConnection({ path: this.path });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`privacy-ocr connect timeout ${this.path}`));
      }, timeoutMs);
      sock.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      sock.once("connect", () => {
        clearTimeout(timer);
        this.sock = sock;
        this.readBuf = Buffer.alloc(0);
        sock.on("data", (c) => this.onData(c));
        sock.on("close", () => {
          this.sock = null;
          this.failPending(new Error("privacy-ocr IPC closed"));
        });
        resolve();
      });
    });
  }

  async hello(opts: { maxBytes: number; ocrTimeoutMs: number; langs?: string }): Promise<void> {
    await this.sendJson(PdocIpcType.Hello, {
      protocol: 1,
      maxBytes: opts.maxBytes,
      ocrTimeoutMs: opts.ocrTimeoutMs,
      langs: opts.langs || "rus+eng",
    });
    const fr = await this.waitFrame(5000);
    if (fr.type !== PdocIpcType.Ready) {
      throw new Error("privacy-ocr: expected Ready after Hello");
    }
  }

  async analyze(
    jobId: string,
    mime: string,
    bytes: Buffer
  ): Promise<
    | { kind: "ocr"; words: OcrWord[] }
    | { kind: "pdf"; text: string; pageCount: number; textual: boolean }
    | { kind: "block"; reason: string }
  > {
    await this.sendJson(PdocIpcType.JobSubmit, {
      jobId,
      mime,
      byteLength: bytes.length,
      op: "analyze",
    });
    await this.sendRaw(PdocIpcType.Blob, bytes);
    const fr = await this.waitFrame(120_000);
    if (fr.type === PdocIpcType.JobBlock) {
      const j = JSON.parse(fr.payload.toString("utf8")) as { reason?: string };
      return { kind: "block", reason: j.reason || "blocked" };
    }
    if (fr.type === PdocIpcType.JobPdfText) {
      const j = JSON.parse(fr.payload.toString("utf8")) as {
        text?: string;
        pageCount?: number;
        textual?: boolean;
      };
      return {
        kind: "pdf",
        text: j.text || "",
        pageCount: j.pageCount ?? 1,
        textual: j.textual === true,
      };
    }
    if (fr.type === PdocIpcType.JobOcrResult) {
      const j = JSON.parse(fr.payload.toString("utf8")) as { words?: OcrWord[] };
      return { kind: "ocr", words: Array.isArray(j.words) ? j.words : [] };
    }
    return { kind: "block", reason: `unexpected_type_${fr.type}` };
  }

  async sanitize(jobId: string, mime: string, bytes: Buffer): Promise<Buffer | { reason: string }> {
    await this.sendJson(PdocIpcType.JobSubmit, {
      jobId,
      mime,
      byteLength: bytes.length,
      op: "sanitize",
    });
    await this.sendRaw(PdocIpcType.Blob, bytes);
    return this.waitDoneBlob(60_000);
  }

  async paint(jobId: string, boxes: PaintBox[], quality = 85): Promise<Buffer | { reason: string }> {
    await this.sendJson(PdocIpcType.JobPaint, { jobId, boxes, quality });
    return this.waitDoneBlob(60_000);
  }

  async close(): Promise<void> {
    try {
      this.sock?.destroy();
    } catch {
      /* */
    }
    this.sock = null;
  }

  private async waitDoneBlob(timeoutMs: number): Promise<Buffer | { reason: string }> {
    const fr = await this.waitFrame(timeoutMs);
    if (fr.type === PdocIpcType.JobBlock) {
      const j = JSON.parse(fr.payload.toString("utf8")) as { reason?: string };
      return { reason: j.reason || "blocked" };
    }
    if (fr.type !== PdocIpcType.JobDone) {
      return { reason: `unexpected_type_${fr.type}` };
    }
    this.waitingBlob = true;
    const blob = await this.waitFrame(timeoutMs);
    this.waitingBlob = false;
    if (blob.type !== PdocIpcType.Blob) {
      return { reason: "missing_blob" };
    }
    return blob.payload;
  }

  private sendJson(type: PdocIpcType, obj: unknown): Promise<void> {
    return this.sendRaw(type, Buffer.from(JSON.stringify(obj), "utf8"));
  }

  private sendRaw(type: PdocIpcType, payload: Buffer): Promise<void> {
    const frame = packPdocFrame(type, payload);
    this.writeChain = this.writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (!this.sock) {
            reject(new Error("not connected"));
            return;
          }
          this.sock.write(frame, (err) => (err ? reject(err) : resolve()));
        })
    );
    return this.writeChain;
  }

  private waitFrame(timeoutMs: number): Promise<{ type: PdocIpcType; payload: Buffer }> {
    return new Promise((resolve, reject) => {
      if (this.pending) {
        reject(new Error("privacy-ocr: overlapping wait"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error("privacy-ocr frame timeout"));
      }, timeoutMs);
      this.pending = { resolve, reject, timer };
    });
  }

  private failPending(err: Error): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    const p = this.pending;
    this.pending = null;
    p.reject(err);
  }

  private onData(chunk: Buffer): void {
    this.readBuf = Buffer.concat([this.readBuf, chunk]);
    while (this.readBuf.length >= PDOC_HEADER_SIZE) {
      const { type, length } = unpackPdocHeader(this.readBuf);
      if (this.readBuf.length < PDOC_HEADER_SIZE + length) return;
      const payload = this.readBuf.subarray(PDOC_HEADER_SIZE, PDOC_HEADER_SIZE + length);
      this.readBuf = this.readBuf.subarray(PDOC_HEADER_SIZE + length);
      if (!this.pending) continue;
      clearTimeout(this.pending.timer);
      const p = this.pending;
      this.pending = null;
      p.resolve({ type: type as PdocIpcType, payload: Buffer.from(payload) });
    }
  }
}
