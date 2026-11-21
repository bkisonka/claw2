// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { startEmbedDaemonServer } from "./embed-daemon.js";

const HOST = "127.0.0.1";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

describe("embed-daemon shutdown", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) return;
    const s = server;
    server = null;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  it("exposes /shutdown without loading the model", async () => {
    server = startEmbedDaemonServer();
    const port = await listen(server);
    const health = await fetch(`http://${HOST}:${port}/health`);
    expect(health.ok).toBe(true);
    const body = (await health.json()) as { ready?: boolean };
    expect(body.ready).toBe(false);

    const res = await fetch(`http://${HOST}:${port}/shutdown`, { method: "POST" });
    expect(res.ok).toBe(true);
    // Handler triggers process.exit in production main(); here only server.close path runs via
    // the shared shutdown helper when invoked as entrypoint. Endpoint itself must respond OK.
    const shut = (await res.json()) as { ok?: boolean };
    expect(shut.ok).toBe(true);
  });
});
