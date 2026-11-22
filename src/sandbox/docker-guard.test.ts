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
  validateContainerCreateBody as checkContainerCreateBody,
  validateNetworkCreateBody,
  validateEgressNetworkInfo,
  SKILL_EGRESS_NETWORK,
  SIDECAR_UPSTREAM_NETWORK,
  EGRESS_SIDECAR_NAME,
} from "./docker-guard.js";

const ROOTS = ["/host/claw2/agents", "/host/claw2/data"];
const validateContainerCreateBody = (body: unknown, roots: string[]) =>
  checkContainerCreateBody(body, roots, "claw2-agent-test");

const hardened = {
  Image: "claw2:latest",
  HostConfig: {
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges"],
    ReadonlyRootfs: true,
    Memory: 536870912,
    PidsLimit: 64,
    NetworkMode: SKILL_EGRESS_NETWORK,
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
assert.equal(isAllowedDockerEndpoint("HEAD", "/_ping"), true);
assert.equal(isAllowedDockerEndpoint("GET", `/v1.47/networks/${SKILL_EGRESS_NETWORK}`), true);
assert.equal(isAllowedDockerEndpoint("GET", `/v1.47/networks/${SIDECAR_UPSTREAM_NETWORK}`), true);
assert.equal(isAllowedDockerEndpoint("GET", "/v1.47/networks/claw2_default"), false);
assert.equal(isAllowedDockerEndpoint("DELETE", `/v1.47/networks/${SKILL_EGRESS_NETWORK}`), false);
assert.equal(isAllowedDockerEndpoint("POST", `/v1.47/networks/${SIDECAR_UPSTREAM_NETWORK}/connect`), false);
assert.equal(isAllowedDockerEndpoint("POST", `/v1.47/networks/${SKILL_EGRESS_NETWORK}/disconnect`), false);
assert.equal(isAllowedDockerEndpoint("GET", "/v1.47/volumes"), false);
assert.equal(isAllowedDockerEndpoint("POST", "/v1.47/images/claw2:latest/push"), false);
assert.equal(isAllowedDockerEndpoint("POST", "/v1.47/swarm/init"), false);
assert.equal(isAllowedDockerEndpoint("GET", "/v1.47/secrets"), false);
assert.equal(isAllowedDockerEndpoint("POST", "/v1.47/networks/create"), true);
assert.equal(isAllowedDockerEndpoint("PUT", "/containers/create"), false);
assert.equal(isAllowedDockerEndpoint("GET", "/containers/../../etc/passwd"), false);

// Both intended bridge profiles, with Docker CLI metadata.
const inner = { Name: SKILL_EGRESS_NETWORK, Driver: "bridge", Internal: true };
const outer = { Name: SIDECAR_UPSTREAM_NETWORK, Driver: "bridge", Internal: false };
const cliFields = { Scope: "", IPAM: { Driver: "default", Options: {}, Config: [] }, Options: {} };
for (const profile of [inner, outer]) {
  assert.deepEqual(validateNetworkCreateBody({ ...profile, ...cliFields }), { ok: true });
  assert.equal(validateNetworkCreateBody({ ...profile, Internal: !profile.Internal }).ok, false);
  assert.deepEqual(validateEgressNetworkInfo({ ...profile, Scope: "local" }, profile.Name), { ok: true });
  assert.equal(validateEgressNetworkInfo({ ...profile, Scope: "swarm" }, profile.Name).ok, false);
}
assert.equal(validateNetworkCreateBody({ ...inner, Name: "claw2-other" }).ok, false);
assert.equal(validateNetworkCreateBody({ ...inner, Driver: "overlay" }).ok, false);
assert.equal(validateNetworkCreateBody({ ...inner, Internal: undefined }).ok, false);
assert.equal(validateEgressNetworkInfo({ ...outer, Scope: "local" }, SKILL_EGRESS_NETWORK).ok, false);

const sidecar = {
  ...hardened,
  NetworkingConfig: { EndpointsConfig: { [SKILL_EGRESS_NETWORK]: {}, [SIDECAR_UPSTREAM_NETWORK]: {} } },
};
assert.equal(checkContainerCreateBody(sidecar, ROOTS, EGRESS_SIDECAR_NAME).ok, true);
assert.equal(checkContainerCreateBody(hardened, ROOTS, EGRESS_SIDECAR_NAME).ok, false, "sidecar requires both networks");
assert.equal(checkContainerCreateBody(hardened, ROOTS, null).ok, false, "request name required");
assert.equal(validateContainerCreateBody(sidecar, ROOTS).ok, false, "skill must not join upstream network");
assert.equal(validateContainerCreateBody({ ...hardened, HostConfig: { ...hardened.HostConfig, NetworkMode: "default" } }, ROOTS).ok, false);

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
{
  // Docker mounts an optionless bind READ-WRITE — the guard must not treat it as ro.
  const implicitRw = structuredClone(hardened) as typeof hardened;
  (implicitRw.HostConfig as Record<string, unknown>).Binds = ["/host/claw2/agents:/app/agents"];
  assert.equal(validateContainerCreateBody(implicitRw, ROOTS).ok, false, "optionless bind (rw in Docker) rejected");
}
{
  const explicitRw = structuredClone(hardened) as typeof hardened;
  (explicitRw.HostConfig as Record<string, unknown>).Binds = ["/host/claw2/agents:/app/agents:rw"];
  assert.equal(validateContainerCreateBody(explicitRw, ROOTS).ok, false, "explicit rw bind rejected");
}
{
  const roWithRw = structuredClone(hardened) as typeof hardened;
  (roWithRw.HostConfig as Record<string, unknown>).Binds = ["/host/claw2/agents:/app/agents:ro,rw"];
  assert.equal(validateContainerCreateBody(roWithRw, ROOTS).ok, false, "ro+rw bind rejected");
}
{
  const shared = structuredClone(hardened) as typeof hardened;
  (shared.HostConfig as Record<string, unknown>).Binds = ["/host/claw2/agents:/app/agents:ro,rshared"];
  assert.equal(validateContainerCreateBody(shared, ROOTS).ok, false, "shared bind propagation rejected");
}
{
  const outputNoOpts = structuredClone(hardened) as typeof hardened;
  (outputNoOpts.HostConfig as Record<string, unknown>).Binds = ["/host/claw2/agents/output:/app/output"];
  assert.equal(validateContainerCreateBody(outputNoOpts, ROOTS).ok, true, "output mount without opts stays allowed");
}

console.log("docker-guard.test.ts: ok");
