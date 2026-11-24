// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Claw2Config } from "../config/types.js";
import { createGatewayServer } from "./server.js";

// The endpoint must end through the graceful stop. The module is mocked so
// the test never spawns a real replacement process.
vi.mock("./shutdown.js", () => ({
  installGracefulShutdown: vi.fn(),
  shutdownGateway: vi.fn(async () => {}),
}));

const { shutdownGateway } = await import("./shutdown.js");

describe("POST /api/restart", () => {
  let server: ReturnType<typeof createGatewayServer>;
  let base = "";

  beforeEach(async () => {
    vi.mocked(shutdownGateway).mockClear();
    const configRef = {
      current: { llm: { provider: "openai", model: "test", baseURL: "http://127.0.0.1:1" } } as Claw2Config,
    };
    server = createGatewayServer(configRef).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test listener");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });

  it("answers at once and ends through the graceful stop, not a bare exit", async () => {
    const response = await fetch(`${base}/api/restart`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    // The endpoint waits 300 ms before handing the process over.
    expect(vi.mocked(shutdownGateway)).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(vi.mocked(shutdownGateway)).toHaveBeenCalledTimes(1), { timeout: 2_000 });

    const [signal, options] = vi.mocked(shutdownGateway).mock.calls[0]!;
    expect(signal).toBe("restart");
    // The replacement process starts from the exit hook, after the turns have stopped.
    expect(typeof options?.exit).toBe("function");
  });
});
