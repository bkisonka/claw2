// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Claw2Config } from "../config/types.js";
import { runAgent, runAgentHost, waitForContainerKills } from "./run-agent.js";

let dir: string;
let agentsDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claw2-run-agent-abort-"));
  agentsDir = join(dir, "agents");
  mkdirSync(agentsDir);
  // The test runner's own Node runs the skill, whatever is on PATH.
  vi.stubEnv("CLAW2_NODE_BIN", process.execPath);
  writeFileSync(join(agentsDir, "loop.js"), 'console.log("started");\nsetInterval(() => {}, 1000);\n');
  writeFileSync(join(agentsDir, "quick.js"), 'console.log("done");\n');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { force: true, recursive: true });
});

/** A long timeout: only the abort may end these runs. */
const config = (useDocker: boolean): Claw2Config =>
  ({
    agentsDir,
    sandbox: { image: "node:20-alpine", useDocker, egress: { mode: "off" }, timeoutMs: 30_000 },
  }) as Claw2;

function aborting(ms: number) {
  const controller = new AbortController();
  setTimeout(() => controller.abort("Chat cancelled"), ms);
  return controller.signal;
}

describe("runAgentHost cancellation", () => {
  it("returns the output of a skill that finishes", async () => {
    const result = await runAgentHost(config(false), { script: "quick.js" });
    expect(result).toMatchObject({ stdout: "done\n", exitCode: 0 });
  });

  it("kills a running skill when the signal aborts", async () => {
    const started = Date.now();
    const result = await runAgentHost(config(false), { script: "loop.js" }, aborting(400));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("[aborted]");
    // What the skill printed before it was stopped is still reported.
    expect(result.stdout).toContain("started");
  });

  it("does not start a skill for an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort("Chat cancelled");
    await expect(runAgentHost(config(false), { script: "quick.js" }, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("runAgent cancellation", () => {
  /**
   * Puts a fake `docker` in front of PATH; `docker run` hangs like a long
   * skill. With `slowKill` the daemon takes a second to answer a kill.
   * Returns the call log path.
   */
  function fakeDocker(slowKill = false): string {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "docker-calls.log");
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh
case "$1" in
  version) echo "27.0.0" ;;
  run) echo "$*" >> "${log}"; exec sleep 30 ;;
  kill) ${slowKill ? "sleep 1; " : ""}echo "$*" >> "${log}"; exit 0 ;;
  *) exit 0 ;;
esac
`
    );
    chmodSync(join(bin, "docker"), 0o755);
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
    return log;
  }

  const calls = (log: string) => readFileSync(log, "utf-8").split("\n").filter(Boolean);

  it("kills the container by name when the signal aborts", async () => {
    const log = fakeDocker();
    const started = Date.now();
    const result = await runAgent(config(true), { script: "loop.js" }, aborting(400));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toMatchObject({ exitCode: -1 });
    expect(result.stderr).toContain("[aborted]");
    // The kill is asked for, not waited for: it lands right after the run returns.
    await waitForContainerKills(5_000);
    const lines = calls(log);
    const runLine = lines.find((line) => line.startsWith("run --rm -i --name "));
    expect(runLine).toBeDefined();
    const containerName = /--name (\S+)/.exec(runLine!)![1]!;
    expect(lines).toContain(`kill ${containerName}`);
  });

  it("does not hold the gateway for a slow daemon: the abort returns at once and the kill still goes out", async () => {
    const log = fakeDocker(true);
    const started = Date.now();
    const result = await runAgent(config(true), { script: "loop.js" }, aborting(400));
    // The abort came at 400 ms; waiting for the kill would have made this 1400.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toMatchObject({ exitCode: -1 });
    await waitForContainerKills(5_000);
    expect(calls(log).some((line) => line.startsWith("kill "))).toBe(true);
  });

  it("still reports a timeout as a timeout", async () => {
    const log = fakeDocker();
    const timed = { ...config(true), sandbox: { ...config(true).sandbox!, timeoutMs: 300 } } as Claw2Config;
    const result = await runAgent(timed, { script: "loop.js" });
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("[timeout]");
    expect(result.stderr).not.toContain("[aborted]");
    await waitForContainerKills(5_000);
    expect(calls(log).some((line) => line.startsWith("kill "))).toBe(true);
  });
});
