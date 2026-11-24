// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Graceful shutdown. A running chat turn lives in the memory of this process
 * and is stored only when it ends, so a gateway that simply dies takes the
 * turn with it: the question is gone and so is the text printed so far. On
 * SIGTERM/SIGINT every running turn is therefore stopped the way Stop stops
 * it — which stores the message, the text so far and the tool steps — before
 * the process exits. A SIGKILL, an OOM kill or a power cut still lose them.
 */

import { DEFAULT_SHUTDOWN_GRACE_MS, stopChatRunsForShutdown } from "./chat-runs.js";
import { waitForContainerKills } from "../sandbox/run-agent.js";

export interface GracefulShutdownOptions {
  /** How long the running turns may take to store themselves (`gateway.shutdownGraceMs`). */
  graceMs?: number;
  /** Ends the process. Replaced in tests. */
  exit?: (code: number) => void;
}

/** Stops the running turns, waits until they are stored, ends the process. */
export async function shutdownGateway(signal: string, options: GracefulShutdownOptions = {}): Promise<void> {
  const exit = options.exit ?? ((code: number): never => process.exit(code));
  const graceMs = options.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const startedAt = Date.now();
  const stuck = await stopChatRunsForShutdown("Gateway is shutting down", graceMs);
  // The skills of the stopped turns were told to die: let the kills reach the
  // daemon, or their containers outlive the gateway.
  await waitForContainerKills(Math.max(0, graceMs - (Date.now() - startedAt)));
  if (stuck.length > 0) {
    console.error(
      `[gateway] ${stuck.length} turn(s) did not stop in ${graceMs} ms and are lost: ${stuck
        .map((run) => run.sessionId)
        .join(", ")}`
    );
  }
  console.error(`[gateway] ${signal}: stopped in ${Date.now() - startedAt} ms`);
  exit(0);
}

/**
 * SIGTERM (docker stop, systemd, a desktop app closing its gateway) and
 * Ctrl+C end the gateway through shutdownGateway. A repeated signal is
 * ignored: the stop is already under way and takes at most the grace period.
 */
export function installGracefulShutdown(options: GracefulShutdownOptions = {}): void {
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    void shutdownGateway(signal, options).catch((err) => {
      console.error("[gateway] shutdown failed:", err);
      (options.exit ?? process.exit)(1);
    });
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}
