/**
 * SMED v1 IPC client over Unix domain socket (Node net).
 * Windows named-pipe: not in v1 — resolveSipMediaBackend falls back to node.
 */
import { createConnection, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import {
  SMED_HEADER_SIZE,
  SmedIpcType,
  packSmedFrame,
  unpackSmedHeader,
} from "./protocol.js";

export type SmedMessageHandler = (type: SmedIpcType, payload: Buffer) => void;

export class SidecarIpcClient extends EventEmitter {
  readonly path: string;
  private sock: Socket | null = null;
  private running = false;
  private ready = false;
  private readyWaiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private readBuf = Buffer.alloc(0);
  private writeChain: Promise<void> = Promise.resolve();

  constructor(path: string) {
    super();
    this.path = path;
  }

  get isReady(): boolean {
    return this.ready && !!this.sock;
  }

  async connect(timeoutMs = 10_000): Promise<void> {
    if (this.sock) throw new Error("sidecar IPC already connected");
    if (process.platform === "win32") {
      throw new Error("sidecar IPC: Unix socket only in v1 (use mediaBackend=node on Windows)");
    }

    await new Promise<void>((resolve, reject) => {
      const sock = createConnection({ path: this.path });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`sidecar IPC connect timeout path=${this.path}`));
      }, timeoutMs);

      sock.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      sock.once("connect", () => {
        clearTimeout(timer);
        sock.setTimeout(0);
        this.sock = sock;
        this.running = true;
        this.ready = false;
        this.readBuf = Buffer.alloc(0);
        sock.on("data", (chunk) => this.onData(chunk));
        sock.on("error", (err) => {
          if (this.running) this.emit("error", err);
        });
        sock.on("close", () => {
          this.running = false;
          this.sock = null;
          this.failReady(new Error("sidecar IPC closed before Ready"));
          this.emit("close");
        });
        resolve();
      });
    });

    await this.waitReady(timeoutMs);
  }

  private waitReady(timeoutMs: number): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w.timer !== timer);
        reject(new Error(`sidecar Ready timeout path=${this.path}`));
      }, timeoutMs);
      this.readyWaiters.push({ resolve, reject, timer });
    });
  }

  private markReady(): void {
    this.ready = true;
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve();
    }
  }

  private failReady(err: Error): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  private onData(chunk: Buffer): void {
    this.readBuf = Buffer.concat([this.readBuf, chunk]);
    while (this.readBuf.length >= SMED_HEADER_SIZE) {
      let type: number;
      let length: number;
      try {
        ({ type, length } = unpackSmedHeader(this.readBuf.subarray(0, SMED_HEADER_SIZE)));
      } catch (err) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
        this.readBuf = Buffer.alloc(0);
        return;
      }
      const total = SMED_HEADER_SIZE + length;
      if (this.readBuf.length < total) return;
      const payload = Buffer.from(this.readBuf.subarray(SMED_HEADER_SIZE, total));
      this.readBuf = this.readBuf.subarray(total);
      const itype = type as SmedIpcType;
      if (itype === SmedIpcType.Ready) this.markReady();
      this.emit("message", itype, payload);
    }
  }

  send(type: SmedIpcType, payload: Buffer | string = Buffer.alloc(0)): void {
    const sock = this.sock;
    if (!sock || !this.running) throw new Error("sidecar IPC not connected");
    const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
    const frame = packSmedFrame(type, body);
    this.writeChain = this.writeChain
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            sock.write(frame, (err) => (err ? reject(err) : resolve()));
          })
      )
      .catch((err) => {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      });
  }

  async close(): Promise<void> {
    this.running = false;
    this.ready = false;
    this.failReady(new Error("sidecar IPC closed"));
    const sock = this.sock;
    this.sock = null;
    if (!sock) return;
    await new Promise<void>((resolve) => {
      sock.once("close", () => resolve());
      sock.destroy();
      setTimeout(resolve, 500);
    });
  }
}
