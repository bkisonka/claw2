#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Test runner for the gateway sources. Discovers every *.test.ts file under
 * src/ and dispatches by framework:
 *   - files importing "vitest" run in one `vitest run` batch;
 *   - standalone assert-based files (each has "Run: npx tsx <file>" in its
 *     header) run one per process via tsx.
 * Either group failing (or timing out) fails the run with a non-zero exit.
 *
 * Usage: npm test [pattern]   # pattern filters by substring of the file path
 */
const { spawnSync } = require("node:child_process");
const { readFileSync, readdirSync } = require("node:fs");
const { join, relative, sep } = require("node:path");

const TSX_FILE_TIMEOUT_MS = 180_000;
const VITEST_BATCH_TIMEOUT_MS = 300_000;
const FAILURE_TAIL = 2_000;

function resolveTsx() {
  try {
    return require.resolve("tsx/cli");
  } catch {
    // Fallback for layouts where tsx is resolvable only from node_modules.
    return join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  }
}

function findTestFiles(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) findTestFiles(p, out);
    else if (e.isFile() && e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const relFromRoot = (root, f) => relative(root, f).split(sep).join("/");

function runVitestBatch(root, files) {
  const rels = files.map((f) => relFromRoot(root, f));
  const r = spawnSync(
    process.execPath,
    [join(root, "node_modules", "vitest", "vitest.mjs"), "run", "--reporter=dot", "--silent=passed-only", ...rels],
    { cwd: root, encoding: "utf-8", timeout: VITEST_BATCH_TIMEOUT_MS }
  );
  const killed = r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM";
  if (r.status === 0 && !killed) {
    console.log(`  ok    vitest batch (${rels.length} files)`);
    return [];
  }
  console.log(
    `  FAIL  vitest batch (${rels.length} files, ${
      killed ? `timeout after ${VITEST_BATCH_TIMEOUT_MS / 1000}s` : `exit code ${r.status ?? "?"}`
    })`
  );
  // Which of the batch files failed: vitest prints "FAIL <path>" lines.
  const failed = new Set();
  for (const line of String(r.stdout || "").split("\n")) {
    const m = line.match(/^ *(?:❯|×|FAIL)\s+(\S+\.test\.ts)/);
    if (m) {
      const hit = rels.find((x) => x === m[1] || x.endsWith(m[1]));
      if (hit) failed.add(hit);
    }
  }
  if (failed.size === 0) rels.forEach((x) => failed.add(x));
  const tail = String(r.stdout || "") + String(r.stderr || "");
  console.log(tail.slice(-FAILURE_TAIL).replace(/^/gm, "    "));
  return [...failed];
}

function runStandaloneFile(root, file) {
  const rel = relFromRoot(root, file);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [resolveTsx(), file], {
    cwd: root,
    encoding: "utf-8",
    timeout: TSX_FILE_TIMEOUT_MS,
    env: { ...process.env, NODE_ENV: "test" },
  });
  const ms = Date.now() - t0;
  const killed = r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM";
  if (r.status === 0 && !killed) {
    console.log(`  ok    ${rel} (${(ms / 1000).toFixed(1)}s)`);
    return null;
  }
  console.log(
    `  FAIL  ${rel} (${
      killed ? `timeout after ${TSX_FILE_TIMEOUT_MS / 1000}s` : `exit code ${r.status ?? "?"}`
    })`
  );
  const tail = String(r.stderr || r.stdout || "").slice(-FAILURE_TAIL);
  if (tail) console.log(tail.replace(/^/gm, "    "));
  return rel;
}

function main() {
  const pattern = process.argv[2];
  const root = join(__dirname, "..");
  const files = findTestFiles(join(root, "src"), []).sort();
  const selected = pattern
    ? files.filter((f) => relFromRoot(root, f).includes(pattern))
    : files;

  if (selected.length === 0) {
    console.error(`run-tests: no test files${pattern ? ` matching "${pattern}"` : ""}`);
    process.exit(1);
  }

  const vitestFiles = selected.filter((f) =>
    /from\s+["']vitest["']/.test(readFileSync(f, "utf-8"))
  );
  const standaloneFiles = selected.filter((f) => !vitestFiles.includes(f));

  const failures = [];
  if (vitestFiles.length > 0) failures.push(...runVitestBatch(root, vitestFiles));
  for (const f of standaloneFiles) {
    const failed = runStandaloneFile(root, f);
    if (failed) failures.push(failed);
  }

  console.log(`\n${selected.length - failures.length}/${selected.length} passed`);
  if (failures.length > 0) {
    console.error(`Failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: npm test [substring-of-test-file-path]");
  process.exit(0);
}
main();
