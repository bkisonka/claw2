// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Graceful shutdown. A running chat turn lives in the memory of this process
 * and is stored only when it ends, so a gateway that simply dies takes the
 * turn with it: the question is gone and so is the text printed so far. On
 * SIGTERM/SIGINT every running turn is therefore stopped the way Stop stops
 * it — which stores the message, the text so far and the tool steps — before
 * the process exits, and what it stores is marked as cut short by the
 * restart. A SIGKILL, an OOM kill or a power cut still lose them.
 */

import { DEFAULT_SHUTDOWN_GRACE_MS, SHUTDOWN_ABORT_REASON, stopChatRunsForShutdown } from "./chat-runs.js";
import { waitForContainerKills } from "../sandbox/run-agent.js";

/**
 * Time kept for the container kills of the stopped skills even when the
 * turns use all of theirs: a kill that is still on its way when the process
 * exits leaves its container running.
 */
export const CONTAINER_KILL_RESERVE_MS = 1_500;

/**
 * How the grace period is split between the running turns and the container
 * kills. The kills get their reserve and the turns the rest — but never less
 * than half, or a short grace period would store no turn at all.
 */
export function splitShutdownGrace(graceMs: number): { turnsMs: number; killsMs: number } {
  const grace = Number.isFinite(graceMs) ? Math.max(0, graceMs) : 0;
  const killsMs = Math.min(CONTAINER_KILL_RESERVE_MS, grace / 2);
  return { turnsMs: grace - killsMs, killsMs };
}

export interface GracefulShutdownOptions {
  /** How long the whole stop may take (`gateway.shutdownGraceMs`). */
  graceMs?: number;
  /** Ends the process. Replaced in tests. */
  exit?: (code: number) => void;
  /** Waits for the container kills. Replaced in tests. */
  waitForKills?: typeof waitForContainerKills;
}

/** Stops the running turns, waits until they are stored, ends the process. */
export async function shutdownGateway(signal: string, options: GracefulShutdownOptions = {}): Promise<void> {
  const exit = options.exit ?? ((code: number): never => process.exit(code));
  const waitForKills = options.waitForKills ?? waitForContainerKills;
  const { turnsMs, killsMs } = splitShutdownGrace(options.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
  const graceMs = turnsMs + killsMs;
  const startedAt = Date.now();
  const stuck = await stopChatRunsForShutdown(SHUTDOWN_ABORT_REASON, turnsMs);
  // The skills of the stopped turns were told to die: let the kills reach the
  // daemon, or their containers outlive the gateway. What the turns did not
  // need is the kills' as well, and the reserve holds even when the event
  // loop ran late while the turns were stopping.
  await waitForKills(Math.max(0, graceMs - (Date.now() - startedAt), killsMs));
  if (stuck.length > 0) {
    console.error(
      `[gateway] ${stuck.length} turn(s) did not stop in the ${turnsMs} ms given to them (of ${graceMs} ms) and are lost: ${stuck
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
