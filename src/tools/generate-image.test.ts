// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Tests for resolveLocalImageFile path allowlist.
 * Run: npx tsx src/tools/generate-image.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { resolveLocalImageFile } from "./generate-image.js";
import type { Claw2Config } from "../config/types.js";

const tmpAgents = resolve(process.cwd(), ".tmp-test-agents-img");
const cfg = { agentsDir: tmpAgents } as Claw2Config;

mkdirSync(resolve(tmpAgents, "output"), { recursive: true });
writeFileSync(resolve(tmpAgents, "output", "sample.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

{
  const ok = resolveLocalImageFile(cfg, "/files/output/sample.png");
  assert.equal(ok.ok, true);
  if (ok.ok) assert.match(ok.fullPath, /sample\.png$/);
}
{
  const ok = resolveLocalImageFile(cfg, "output/sample.png");
  assert.equal(ok.ok, true);
}
{
  const bad = resolveLocalImageFile(cfg, "/files/../etc/passwd");
  assert.equal(bad.ok, false);
}
{
  const bad = resolveLocalImageFile(cfg, "/files/output/missing.png");
  assert.equal(bad.ok, false);
}

rmSync(tmpAgents, { recursive: true, force: true });
console.log("generate-image tests: ok");
