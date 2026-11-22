// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Docker API guard: endpoint allowlist + container-create body validation.
 *
 * Run: npx tsx src/sandbox/docker-guard.test.ts
 */
import assert from "node:assert/strict";
import {
  isAllowedDockerEndpoint,
  validateContainerCreateBody,
  validateNetworkCreateBody,
  validateNetworkConnectBody,
} from "./docker-guard.js";

const ROOTS = ["/host/claw2/agents", "/host/claw2/data"];

const hardened = {
  Image: "claw2:latest",
  HostConfig: {
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges"],
    ReadonlyRootfs: true,
    Memory: 536870912,
    PidsLimit: 64,
    Binds: ["/host/claw2/agents:/app/agents:ro", "/host/claw2/agents/output:/app/output", "/host/claw2/data/egress-preload.cjs:/app/.claw2-egress-preload.cjs:ro"],
  },
};

// Endpoint allowlist
assert.equal(isAllowedDockerEndpoint("GET", "/v1.47/_ping"), true);
assert.equal(isAllowedDockerEndpoint("GET", "/version"), true);
assert.equal(isAllowedDockerEndpoint("POST", "/v1.47/containers/create"), true);
assert.equal(isAllowedDockerEndpoint("GET", "/v1.47/containers/claw2-agent-x/json"), true);
assert.equal(isAllowedDockerEndpoint("POST", "/v1.47/containers/claw2-agent-x/wait"), true);
assert.equal(isAllowedDockerEndpoint("DELETE", "/v1.47/containers/claw2-agent-x"), true);
assert.equal(isAllowedDockerEndpoint("GET", "/v1.47/images/node:20-alpine/json"), true, "image ref with tag");
assert.equal(isAllowedDockerEndpoint("GET", "/v1.47/images/ghcr.io/x/y:z/json"), true, "registry image ref");
assert.equal(isAllowedDockerEndpoint("POST", "/v1.47/containers/claw2-agent-x/exec"), false, "exec must be denied");
// Foreign containers/networks are out of scope even via allowed endpoints:
assert.equal(isAllowedDockerEndpoint("POST", "/v1.47/containers/postgres-1/kill"), false, "foreign container kill denied");
assert.equal(isAllowedDockerEndpoint("GET", "/v1.47/containers/claw2-egress-sidecar/logs"), true);
assert.equal(isAllowedDockerEndpoint("DELETE", "/v1.47/networks/claw2-skill-egress"), true);
assert.equal(isAllowedDockerEndpoint("DELETE", "/v1.47/networks/bridge"), false, "foreign network denied");
assert.equal(isAllowedDockerEndpoint("GET", "/v1.47/volumes"), false);
assert.equal(isAllowedDockerEndpoint("POST", "/v1.47/images/claw2:latest/push"), false);
assert.equal(isAllowedDockerEndpoint("POST", "/v1.47/swarm/init"), false);
assert.equal(isAllowedDockerEndpoint("GET", "/v1.47/secrets"), false);
assert.equal(isAllowedDockerEndpoint("POST", "/v1.47/networks/create"), true);
assert.equal(isAllowedDockerEndpoint("PUT", "/containers/create"), false);
assert.equal(isAllowedDockerEndpoint("GET", "/containers/../../etc/passwd"), false);

// Network name scoping
assert.deepEqual(validateNetworkCreateBody({ Name: "claw2-skill-egress" }), { ok: true });
assert.equal(validateNetworkCreateBody({ Name: "host-net" }).ok, false);
assert.equal(validateNetworkConnectBody({ Container: "claw2-agent-x" }).ok, true);
assert.equal(validateNetworkConnectBody({ Container: "postgres" }).ok, false, "foreign connect target denied");

// Container create validation
{
  const r = validateContainerCreateBody(hardened, ROOTS);
  assert.deepEqual(r, { ok: true }, `hardened body must pass: ${r.error ?? ""}`);
}
{
  const privileged = structuredClone(hardened) as typeof hardened;
  (privileged.HostConfig as Record<string, unknown>).Privileged = true;
  assert.equal(validateContainerCreateBody(privileged, ROOTS).ok, false, "privileged rejected");
}
{
  const capAdd = structuredClone(hardened) as typeof hardened;
  (capAdd.HostConfig as Record<string, unknown>).CapAdd = ["SYS_ADMIN"];
  assert.equal(validateContainerCreateBody(capAdd, ROOTS).ok, false, "CapAdd rejected");
}
{
  const capDropMissing = structuredClone(hardened) as typeof hardened;
  (capDropMissing.HostConfig as Record<string, unknown>).CapDrop = ["CHOWN"];
  assert.equal(validateContainerCreateBody(capDropMissing, ROOTS).ok, false, "CapDrop ALL required");
}
{
  const rwRootfs = structuredClone(hardened) as typeof hardened;
  (rwRootfs.HostConfig as Record<string, unknown>).ReadonlyRootfs = false;
  assert.equal(validateContainerCreateBody(rwRootfs, ROOTS).ok, false, "read-only rootfs required");
}
{
  const hostBind = structuredClone(hardened) as typeof hardened;
  (hostBind.HostConfig as Record<string, unknown>).Binds = ["/:/host:ro"];
  assert.equal(validateContainerCreateBody(hostBind, ROOTS).ok, false, "host root bind rejected");
}
{
  const outsideRoot = structuredClone(hardened) as typeof hardened;
  (outsideRoot.HostConfig as Record<string, unknown>).Binds = ["/etc:/app/agents:ro"];
  assert.equal(validateContainerCreateBody(outsideRoot, ROOTS).ok, false, "src outside sandbox roots rejected");
}
{
  const traversal = structuredClone(hardened) as typeof hardened;
  (traversal.HostConfig as Record<string, unknown>).Binds = ["/host/claw2/agents/../secrets:/app/x:ro"];
  assert.equal(validateContainerCreateBody(traversal, ROOTS).ok, false, "traversal bind rejected");
}
{
  const badDst = structuredClone(hardened) as typeof hardened;
  (badDst.HostConfig as Record<string, unknown>).Binds = ["/host/claw2/agents:/etc/passwd:ro"];
  assert.equal(validateContainerCreateBody(badDst, ROOTS).ok, false, "bind target outside /app rejected");
}
{
  const ports = structuredClone(hardened) as typeof hardened;
  (ports.HostConfig as Record<string, unknown>).PortBindings = { "80/tcp": [{ HostPort: "8080" }] };
  assert.equal(validateContainerCreateBody(ports, ROOTS).ok, false, "published ports rejected");
}
{
  const netHost = structuredClone(hardened) as typeof hardened;
  (netHost.HostConfig as Record<string, unknown>).NetworkMode = "host";
  assert.equal(validateContainerCreateBody(netHost, ROOTS).ok, false, "host network rejected");
}
{
  const mounts = structuredClone(hardened) as typeof hardened;
  (mounts.HostConfig as Record<string, unknown>).Mounts = [{ Type: "bind", Source: "/", Target: "/host" }];
  assert.equal(validateContainerCreateBody(mounts, ROOTS).ok, false, "volume mounts rejected");
}
{
  const noRoots = validateContainerCreateBody(hardened, []);
  assert.equal(noRoots.ok, false, "empty bind-source allowlist rejects all binds (fail closed)");
}

console.log("docker-guard.test.ts: ok");
