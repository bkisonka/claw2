// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Claw2Config } from "../config/types.js";
import { createGatewayServer } from "./server.js";

it("serves personal file reads with a path grant or gateway key, and preserves fail-closed auth", async () => {
  const agentsDir = mkdtempSync(join(tmpdir(), "claw2-file-access-"));
  const auth = { enabled: true, apiKey: "local-test-gateway-key" };
  const config: Claw2Config = { agentsDir, gateway: { auth } };
  mkdirSync(join(agentsDir, "output"));
  writeFileSync(join(agentsDir, "output", "test file.png"), "first");
  writeFileSync(join(agentsDir, "output", "second.png"), "second");
  const server = createGatewayServer({ current: config }).listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP listener");
    const base = `http://127.0.0.1:${address.port}`;
    const get = (path: string, init?: RequestInit) => fetch(`${base}${path}`, { signal: AbortSignal.timeout(3000), ...init });
    const first = "/files/output/test%20file.png";
    const headers = { "X-API-Key": auth.apiKey };
    const issueUrl = `/api/files-token?${new URLSearchParams({ path: first })}`;
    expect((await get(first)).status).toBe(401);
    expect((await get(issueUrl)).status).toBe(401);
    const issue = await get(issueUrl, { headers });
    expect(issue.status).toBe(200);
    const { k } = await issue.json() as { k: string };
    const q = new URLSearchParams({ k });
    expect(await (await get(`${first}?${q}`)).text()).toBe("first");
    expect(await (await get(first, { headers })).text()).toBe("first");
    expect((await get(`/files/output/second.png?${q}`)).status).toBe(401);
    expect((await get(`${first}?${q}`, { method: "DELETE" })).status).toBe(401);
    auth.apiKey = "";
    expect((await get(`${first}?${q}`)).status).toBe(401);
    auth.apiKey = headers["X-API-Key"];
    config.gateway!.auth!.registrationEnabled = true;
    expect((await get(`${first}?${q}`)).status).toBe(401);
    config.gateway!.auth!.registrationEnabled = false;
    auth.enabled = false;
    expect(await (await get(first)).text()).toBe("first");
  } finally {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
    rmSync(agentsDir, { recursive: true, force: true });
  }
});
