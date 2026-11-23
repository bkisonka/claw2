// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Sibling bind mapping: host paths come from the gateway container's own
 * mounts (daemon view), CLAW2_SIBLING_HOST_ROOT is the flat fallback.
 * Regression: ${PWD} baked by compose followed the directory compose was
 * launched from, the daemon created empty directories in place of the bind
 * sources and every skill died on `--require /app/.claw2-egress-preload.cjs`.
 */
import { describe, it, expect } from "vitest";
import { mapSandboxPathToHost, parseSiblingMounts } from "./run-agent.js";

describe("parseSiblingMounts", () => {
  // Real `docker container inspect -f` output for the compose gateway.
  const output = [
    "bind\t/app/.claw2\t/home/mktari/claw2public/.claw2",
    "bind\t/app/agents\t/home/mktari/claw2public/agents",
    "bind\t/app/data\t/home/mktari/claw2public/data",
    "bind\t/etc/localtime\t/etc/localtime",
    "",
  ].join("\n");

  it("keeps the sandbox binds with their daemon-reported sources", () => {
    expect([...parseSiblingMounts(output)]).toEqual([
      ["/app/agents", "/home/mktari/claw2public/agents"],
      ["/app/data", "/home/mktari/claw2public/data"],
    ]);
    expect(mapSandboxPathToHost("/app/agents/web-search.js", parseSiblingMounts(output), "")).toBe(
      "/home/mktari/claw2public/agents/web-search.js"
    );
  });

  it("ignores mounts outside the sandbox, named volumes and relative sources", () => {
    expect(parseSiblingMounts("bind\t/app/uploads\t/home/mktari/claw2public/agents/uploads").size).toBe(0);
    expect(parseSiblingMounts("volume\t/app/agents\tclaw2-agents").size).toBe(0);
    expect(parseSiblingMounts("bind\t/app/agents\tagents").size).toBe(0);
    expect(parseSiblingMounts("").size).toBe(0);
  });

  it("parses nothing when the template printed a literal backslash-t instead of tabs", () => {
    expect(parseSiblingMounts("bind\\t/app/agents\\t/home/mktari/claw2public/agents\n").size).toBe(0);
  });
});

const MOUNTS = new Map([
  ["/app/agents", "/srv/claw2public/agents"],
  ["/app/data", "/srv/claw2public/data"],
]);

describe("mapSandboxPathToHost", () => {
  it("follows the gateway's mounts, not a host root", () => {
    expect(mapSandboxPathToHost("/app/agents", MOUNTS, "/somewhere/else")).toBe("/srv/claw2public/agents");
    expect(mapSandboxPathToHost("/app/agents/output", MOUNTS, "/somewhere/else")).toBe("/srv/claw2public/agents/output");
    expect(mapSandboxPathToHost("/app/agents/uploads", MOUNTS, "/somewhere/else")).toBe("/srv/claw2public/agents/uploads");
    expect(mapSandboxPathToHost("/app/data/egress-preload.cjs", MOUNTS, "/somewhere/else")).toBe(
      "/srv/claw2public/data/egress-preload.cjs"
    );
  });

  it("prefers the longest matching mount", () => {
    const nested = new Map([...MOUNTS, ["/app/agents/output", "/srv/scratch/out"]]);
    expect(mapSandboxPathToHost("/app/agents/output", nested, "")).toBe("/srv/scratch/out");
    expect(mapSandboxPathToHost("/app/agents/output/a.txt", nested, "")).toBe("/srv/scratch/out/a.txt");
    expect(mapSandboxPathToHost("/app/agents/web-search.js", nested, "")).toBe("/srv/claw2public/agents/web-search.js");
  });

  it("does not match a path that merely shares a prefix", () => {
    expect(mapSandboxPathToHost("/app/agents-other/x", MOUNTS, "")).toBeNull();
    expect(mapSandboxPathToHost("/app/dat", MOUNTS, "")).toBeNull();
  });

  it("falls back to CLAW2_SIBLING_HOST_ROOT only where no mount covers the path", () => {
    expect(mapSandboxPathToHost("/app/output", MOUNTS, "/srv/claw2public")).toBe("/srv/claw2public/output");
    expect(mapSandboxPathToHost("/app", new Map(), "/srv/claw2public")).toBe("/srv/claw2public");
    expect(mapSandboxPathToHost("/app/agents", new Map(), "/srv/claw2public")).toBe("/srv/claw2public/agents");
  });

  it("refuses anything it cannot place", () => {
    expect(mapSandboxPathToHost("/app/output", MOUNTS, "")).toBeNull();
    expect(mapSandboxPathToHost("/app/output", new Map(), "")).toBeNull();
    expect(mapSandboxPathToHost("/etc", MOUNTS, "/srv/claw2public")).toBeNull();
    expect(mapSandboxPathToHost("/app", MOUNTS, "")).toBeNull();
  });
});
