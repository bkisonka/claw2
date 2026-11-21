#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Launch Gateway: HTTP API on the port from the config (gateway.port).
 * POST /chat - body { message, sessionId? }, response { content, sessionId }.
 */

import { getConfigPath, loadConfig } from "../config/load.js";
import { startGateway } from "./server.js";

/** Parent may close stdout/stderr pipes (desktop log reader); don't crash on EPIPE. */
function ignoreBrokenPipe(stream: NodeJS.WriteStream | null | undefined): void {
  stream?.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") return;
    throw err;
  });
}
ignoreBrokenPipe(process.stdout);
ignoreBrokenPipe(process.stderr);

/**
 * Desktop local runtime must stay up if a SIP stack bug throws from a DNS callback.
 * Root cause for dial crashes is guarded in src/sip/dial-uri.ts; this is a safety net.
 */
process.on("uncaughtException", (err) => {
  console.error("[gateway] uncaughtException (kept alive):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[gateway] unhandledRejection:", reason);
});

const configPath = getConfigPath();
const configRef = { current: loadConfig(configPath) };
console.error(`[gateway] Config loaded from ${configPath}`);
startGateway(configRef);
