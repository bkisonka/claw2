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
import {
  createDockerGuardServer,
  SKILL_EGRESS_NETWORK,
  SIDECAR_UPSTREAM_NETWORK,
  EGRESS_SIDECAR_NAME,
} from "./docker-guard.js";

const dir = mkdtempSync(join(tmpdir(), "claw2-guard-http-"));
const sockPath = join(dir, "docker.sock");
const ROOTS = ["/host/claw2/agents", "/host/claw2/data"];

try {
  // Fake docker daemon: records method/path/body per request.
  const seen: { method: string; path: string; body: string }[] = [];
  let innerInternal = true;
  let outerAvailable = true;
  const daemon = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", path: req.url ?? "", body: Buffer.concat(chunks).toString("utf-8") });
      res.setHeader("Content-Type", "application/json");
      const inner = req.method === "GET" && req.url === `/networks/${SKILL_EGRESS_NETWORK}`;
      const outer = req.method === "GET" && req.url === `/networks/${SIDECAR_UPSTREAM_NETWORK}`;
      if (inner || outer) {
        if (outer && !outerAvailable) {
          res.writeHead(404);
          res.end(JSON.stringify({ message: "network not found" }));
          return;
        }
        res.end(JSON.stringify({
          Name: inner ? SKILL_EGRESS_NETWORK : SIDECAR_UPSTREAM_NETWORK,
          Internal: inner && innerInternal,
          Driver: "bridge",
          Scope: "local",
        }));
      } else {
        res.end(JSON.stringify({ Id: "claw2-agent-test", Warnings: [] }));
      }
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

  const agentCreatePath = "/v1.47/containers/create?name=claw2-agent-e2e";
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
    Image: "node:20-alpine",
    HostConfig: {
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      ReadonlyRootfs: true,
      Binds: ["/host/claw2/agents:/app/agents:ro", "/host/claw2/agents/output:/app/output"],
      Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" },
      NetworkMode: SKILL_EGRESS_NETWORK,
    },
    NetworkingConfig: { EndpointsConfig: {} },
  };

  // 1. Validated create: body must reach the daemon, response must come back.
  const r1 = await post(agentCreatePath, hardened);
  assert.equal(r1.status, 200, `create must pass: ${r1.text}`);
  assert.deepEqual(seen.map((s) => s.path), [`/networks/${SKILL_EGRESS_NETWORK}`, agentCreatePath]);
  assert.equal(seen[1].method, "POST");
  assert.equal(seen[1].body, JSON.stringify(hardened), "upstream received the full original body");

  // 2. Both named network create requests retain the exact original body.
  for (const [Name, Internal] of [[SKILL_EGRESS_NETWORK, true], [SIDECAR_UPSTREAM_NETWORK, false]] as const) {
    const network = { Name, Internal, Driver: "bridge" };
    const r2 = await post("/v1.47/networks/create", network);
    assert.equal(r2.status, 200, `network create must pass: ${r2.text}`);
    assert.equal(seen.at(-1)?.body, JSON.stringify(network));
  }

  // 3. Only the named sidecar has both networks. Wrong or missing network
  // properties must stop the request before the daemon receives create.
  const sidecarPath = `/v1.47/containers/create?name=${EGRESS_SIDECAR_NAME}`;
  const sidecar = {
    ...hardened,
    NetworkingConfig: { EndpointsConfig: { [SKILL_EGRESS_NETWORK]: {}, [SIDECAR_UPSTREAM_NETWORK]: {} } },
  };
  seen.length = 0;
  assert.equal((await post(sidecarPath, sidecar)).status, 200);
  assert.deepEqual(seen.map((s) => s.path), [`/networks/${SKILL_EGRESS_NETWORK}`, `/networks/${SIDECAR_UPSTREAM_NETWORK}`, sidecarPath]);
  seen.length = 0;
  assert.equal((await post(agentCreatePath, sidecar)).status, 403);
  assert.equal((await post("/v1.47/containers/create", hardened)).status, 403);
  assert.equal((await post(`${agentCreatePath}&name=${EGRESS_SIDECAR_NAME}`, sidecar)).status, 403);
  assert.deepEqual(seen, []);
  innerInternal = false;
  assert.equal((await post(agentCreatePath, hardened)).status, 403);
  innerInternal = true;
  outerAvailable = false;
  assert.equal((await post(sidecarPath, sidecar)).status, 403);
  assert.deepEqual(seen.map((s) => s.method), ["GET", "GET", "GET"]);

  // 4. container:<name> namespace sharing rejected.
  const r4 = await post(agentCreatePath, {
    ...hardened,
    HostConfig: { ...hardened.HostConfig, NetworkMode: "container:postgres" },
  });
  assert.equal(r4.status, 403, "container: network mode rejected");

  // 5. Restart policy rejected.
  const r5 = await post(agentCreatePath, {
    ...hardened,
    HostConfig: { ...hardened.HostConfig, RestartPolicy: { Name: "always" } },
  });
  assert.equal(r5.status, 403, "restart policy rejected");

  // 6. Exec tmpfs rejected.
  const r6 = await post(agentCreatePath, {
    ...hardened,
    HostConfig: { ...hardened.HostConfig, Tmpfs: { "/": "rw,exec" } },
  });
  assert.equal(r6.status, 403, "tmpfs over / rejected");

  // 7. VolumesFrom rejected.
  const r7 = await post(agentCreatePath, {
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

  guard.close();
  daemon.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("docker-guard-http.test.ts: ok");
