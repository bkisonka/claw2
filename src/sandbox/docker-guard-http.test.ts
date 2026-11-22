// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * HTTP round-trip through the guard with a fake docker daemon on a unix
 * socket. Regression test: validated POSTs consume the request body for
 * validation and MUST re-send it upstream — piping an already-ended request
 * forwards zero bytes and the daemon hangs (the bug that made every
 * containers/create/networks/create deadlock under compose).
 *
 * Run: npx tsx src/sandbox/docker-guard-http.test.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDockerGuardServer } from "./docker-guard.js";

const dir = mkdtempSync(join(tmpdir(), "claw2-guard-http-"));
const sockPath = join(dir, "docker.sock");
const ROOTS = ["/host/claw2/agents", "/host/claw2/data"];

try {
  // Fake docker daemon: records method/path/body per request.
  const seen: { method: string; path: string; body: string }[] = [];
  const daemon = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", path: req.url ?? "", body: Buffer.concat(chunks).toString("utf-8") });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ Id: "claw2-agent-test", Warnings: [] }));
    });
  });
  await new Promise<void>((resolve) => daemon.listen(sockPath, resolve));

  const guard = createDockerGuardServer({
    socketPath: sockPath,
    allowedBindSrc: ROOTS,
    selfName: "claw2-docker-guard",
  });
  await new Promise<void>((resolve) => guard.listen(0, "127.0.0.1", resolve));
  const addr = guard.address();
  const base = `http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}`;

  const post = (path: string, body: unknown): Promise<{ status: number; text: string }> =>
    new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const r = http.request(
        `${base}${path}`,
        { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
        (pres) => {
          const out: Buffer[] = [];
          pres.on("data", (c: Buffer) => out.push(c));
          pres.on("end", () => resolve({ status: pres.statusCode ?? 0, text: Buffer.concat(out).toString("utf-8") }));
        }
      );
      r.on("error", reject);
      // Explicit overall timeout: the deadlock bug manifests as a hang.
      r.setTimeout(3000, () => reject(new Error("guard response timeout (deadlocked?)")));
      r.end(payload);
    });

  const hardened = {
    Name: "claw2-agent-e2e",
    Image: "node:20-alpine",
    HostConfig: {
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      ReadonlyRootfs: true,
      Binds: ["/host/claw2/agents:/app/agents:ro", "/host/claw2/agents/output:/app/output"],
      Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" },
      NetworkMode: "claw2-skill-egress",
    },
    NetworkingConfig: { EndpointsConfig: [{ Network: "claw2-skill-egress" }] },
  };

  // 1. Validated create: body must reach the daemon, response must come back.
  const r1 = await post("/v1.47/containers/create?name=claw2-agent-e2e", hardened);
  assert.equal(r1.status, 200, `create must pass: ${r1.text}`);
  const createReq = seen.find((s) => s.path.includes("/containers/create"));
  assert.ok(createReq, "daemon saw the create request");
  assert.equal(createReq!.method, "POST");
  const echoed = JSON.parse(createReq!.body) as Record<string, unknown>;
  assert.equal(echoed.Name, "claw2-agent-e2e", "upstream received the FULL body (not zero bytes)");
  assert.equal((echoed.HostConfig as Record<string, unknown>).ReadonlyRootfs, true);

  // 2. Network create with driver validation.
  const r2 = await post("/v1.47/networks/create", { Name: "claw2-skill-egress", Internal: true });
  assert.equal(r2.status, 200, `network create must pass: ${r2.text}`);
  assert.equal(validateHelper(seen, "/networks/create")?.body.includes("claw2-skill-egress"), true);

  // 3. Non-claw2 endpoint network rejected at the guard.
  const r3 = await post("/v1.47/containers/create", {
    ...hardened,
    NetworkingConfig: { EndpointsConfig: [{ Network: "bridge" }] },
  });
  assert.equal(r3.status, 403, "bridge attachment rejected");
  assert.ok(r3.text.includes("claw2 network"));

  // 4. container:<name> namespace sharing rejected.
  const r4 = await post("/v1.47/containers/create", {
    ...hardened,
    HostConfig: { ...hardened.HostConfig, NetworkMode: "container:postgres" },
  });
  assert.equal(r4.status, 403, "container: network mode rejected");

  // 5. Restart policy rejected.
  const r5 = await post("/v1.47/containers/create", {
    ...hardened,
    HostConfig: { ...hardened.HostConfig, RestartPolicy: { Name: "always" } },
  });
  assert.equal(r5.status, 403, "restart policy rejected");

  // 6. Exec tmpfs rejected.
  const r6 = await post("/v1.47/containers/create", {
    ...hardened,
    HostConfig: { ...hardened.HostConfig, Tmpfs: { "/": "rw,exec" } },
  });
  assert.equal(r6.status, 403, "tmpfs over / rejected");

  // 7. VolumesFrom rejected.
  const r7 = await post("/v1.47/containers/create", {
    ...hardened,
    HostConfig: { ...hardened.HostConfig, VolumesFrom: ["postgres"] },
  });
  assert.equal(r7.status, 403, "VolumesFrom rejected");

  // 8. docker load (fromSrc) rejected.
  const r8 = await post("/v1.47/images/create?fromSrc=-", {});
  assert.equal(r8.status, 403, "docker load rejected");

  // 9. Self-protection: the guard refuses ops on its own container.
  const r9 = await new Promise<{ status: number }>((resolve, reject) => {
    const r = http.request(`${base}/v1.47/containers/claw2-docker-guard/kill`, { method: "POST" }, (pres) => {
      pres.resume();
      pres.on("end", () => resolve({ status: pres.statusCode ?? 0 }));
    });
    r.on("error", reject);
    r.end();
  });
  assert.equal(r9.status, 403, "self-targeted kill refused");

  // 10. Plain GET forwards live (no body to replay).
  seen.length = 0;
  const r10 = await new Promise<{ status: number }>((resolve, reject) => {
    const r = http.request(`${base}/v1.47/version`, { method: "GET" }, (pres) => {
      pres.resume();
      pres.on("end", () => resolve({ status: pres.statusCode ?? 0 }));
    });
    r.on("error", reject);
    r.end();
  });
  assert.equal(r10.status, 200, "GET passthrough works");

  function validateHelper(list: typeof seen, pathPart: string) {
    return list.find((s) => s.path.includes(pathPart));
  }

  guard.close();
  daemon.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("docker-guard-http.test.ts: ok");
