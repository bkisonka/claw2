// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * safeRealPath: symlink components (final AND intermediate) are rejected;
 * non-existent tails resolve lexically onto the canonical existing prefix.
 *
 * Run: npx tsx src/security/safe-fs.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRealPath } from "./safe-fs.js";

const dir = mkdtempSync(join(tmpdir(), "claw2-safe-fs-"));
try {
  const real = join(dir, "agents", "output");
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, "report.txt"), "hello");

  // Plain existing file: canonicalizes to itself.
  const r1 = safeRealPath(join(real, "report.txt"));
  assert.ok(r1.ok && r1.path === join(real, "report.txt"), `plain file: ${r1.error ?? r1.path}`);

  // Not-yet-existing file inside an existing dir: OK (lexical tail).
  const r2 = safeRealPath(join(real, "new", "deep", "file.txt"));
  assert.ok(r2.ok, `missing tail must pass: ${r2.error ?? ""}`);
  assert.equal(r2.path, join(real, "new", "deep", "file.txt"));

  // Planted symlink as the FINAL component: rejected.
  symlinkSync("/etc/passwd", join(real, "link-final"));
  const r3 = safeRealPath(join(real, "link-final"));
  assert.ok(!r3.ok, "final symlink must be rejected");

  // Planted symlink as an INTERMEDIATE component: rejected.
  const outside = join(dir, "secrets");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "key.pem"), "secret");
  symlinkSync(outside, join(real, "link-dir"));
  const r4 = safeRealPath(join(real, "link-dir", "key.pem"));
  assert.ok(!r4.ok, "intermediate symlink must be rejected");

  // Symlink chain deeper in the tail: rejected via component walk.
  mkdirSync(join(real, "sub"), { recursive: true });
  symlinkSync(join(outside, "key.pem"), join(real, "sub", "evil.js"));
  const r5 = safeRealPath(join(real, "sub", "evil.js"));
  assert.ok(!r5.ok, "tail symlink must be rejected");

  // After deleting the real dir, the walk still resolves lexically (create path).
  rmSync(real, { recursive: true, force: true });
  const r6 = safeRealPath(join(dir, "agents", "output", "fresh.txt"));
  assert.ok(r6.ok, `re-created path must pass: ${r6.error ?? ""}`);
  assert.equal(r6.path, join(dir, "agents", "output", "fresh.txt"));
  assert.ok(!existsSync(join(dir, "agents", "output")), "the check must not create anything");
  assert.ok(existsSync(join(dir, "agents")), "the pre-existing parent is untouched");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("safe-fs.test.ts: ok");
