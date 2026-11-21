// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { buildHostPermissionArgs, collectHostAgentDependencyRoots } from "./run-agent.js";
import type { Claw2Config } from "../config/types.js";

describe("collectHostAgentDependencyRoots", () => {
  it("includes agents/node_modules realpath when present", () => {
    const agents = join(homedir(), ".claw2", "agents");
    if (!existsSync(join(agents, "node_modules"))) return;
    const roots = collectHostAgentDependencyRoots(agents);
    expect(roots.some((r) => r.includes("node_modules"))).toBe(true);
  });
});

describe("buildHostPermissionArgs", () => {
  it("allows reading dependency roots under default hostFs", () => {
    const agents = join(homedir(), ".claw2", "agents");
    const output = join(agents, "output");
    const config = { sandbox: { useDocker: false } } as Claw2Config;
    const args = buildHostPermissionArgs(config, agents, output, join(agents, "uploads"));
    if (args.length === 0) return; // Node without --permission
    expect(args).toContain("--permission");
    const readFlags = args.filter((a) => a.startsWith("--allow-fs-read="));
    expect(readFlags.length).toBeGreaterThan(1);
    if (existsSync(join(agents, "node_modules"))) {
      expect(readFlags.some((a) => a.includes("node_modules"))).toBe(true);
    }
  });
});
