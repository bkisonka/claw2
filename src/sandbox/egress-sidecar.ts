// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Standalone egress guard sidecar for the Docker sandbox tier. Bundled to a
 * single CJS file (dist/egress-sidecar.cjs) and run inside a minimal node
 * container attached to (a) the skill containers' --internal network and
 * (b) a normal bridge network with internet. Skill containers have no
 * external route at all — the sidecar is their only way out, and it applies
 * the same SSRF rules as web_fetch. Nothing is published to the host.
 *
 * Env: CLAW2_EGRESS_ALLOW_PRIVATE=1 mirrors tools.webFetch.allowPrivateHosts.
 * Readiness: GET /health → 200 once listening.
 */
import { createEgressGuardProxy } from "./egress-proxy.js";

const PORT = 3128;

const guard = createEgressGuardProxy({
  allowPrivateHosts: process.env.CLAW2_EGRESS_ALLOW_PRIVATE === "1",
  onBlocked: ({ host, port, reason }) => {
    console.error(
      JSON.stringify({ egress_blocked: true, host, port, reason, ts: Date.now() })
    );
  },
});

guard
  .listenOn("0.0.0.0", PORT)
  .then((port) => {
    console.log(JSON.stringify({ egress_sidecar_ready: true, port }));
  })
  .catch((err) => {
    console.error(
      JSON.stringify({
        egress_sidecar_fatal: true,
        error: err instanceof Error ? err.message : String(err),
      })
    );
    process.exit(1);
  });

// Keep the process alive: guard listeners hold the loop; an explicit exit is
// only expected from the fatal path above.
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
