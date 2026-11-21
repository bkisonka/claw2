// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Locates (and, in dev setups, builds) the bundled egress preload
 * (dist/egress-preload.cjs) that skills receive via NODE_OPTIONS --require.
 * Production builds produce it in the normal build step; dev (tsx src/…)
 * runs without dist, so the first skill run builds it on demand — and
 * egress guard stays fail-closed if even that is not possible.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** Absolute path of the bundled preload, when present. */
export function findPreloadPath(): string | null {
  // dist/sandbox/this-module.js → dist/egress-preload.cjs
  const fromModule = resolve(dirname(fileURLToPath(import.meta.url)), "../../egress-preload.cjs");
  if (existsSync(fromModule)) return fromModule;
  // Dev fallbacks: repo root layout.
  const fromSrc = resolve(dirname(fileURLToPath(import.meta.url)), "../../../dist/egress-preload.cjs");
  if (existsSync(fromSrc)) return fromSrc;
  const fromCwd = resolve(process.cwd(), "dist/egress-preload.cjs");
  if (existsSync(fromCwd)) return fromCwd;
  return null;
}

/** Absolute path of the bundled sidecar entry, when present. */
export function findSidecarPath(): string | null {
  const fromModule = resolve(dirname(fileURLToPath(import.meta.url)), "../../egress-sidecar.cjs");
  if (existsSync(fromModule)) return fromModule;
  const fromSrc = resolve(dirname(fileURLToPath(import.meta.url)), "../../../dist/egress-sidecar.cjs");
  if (existsSync(fromSrc)) return fromSrc;
  const fromCwd = resolve(process.cwd(), "dist/egress-sidecar.cjs");
  if (existsSync(fromCwd)) return fromCwd;
  return null;
}

function esbuildBundle(srcFile: string, outFile: string): { ok: true } | { ok: false; error: string } {
  const r = runEsbuild([
    srcFile,
    "--bundle",
    "--platform=node",
    "--format=cjs",
    `--outfile=${outFile}`,
    "--log-level=error",
  ]);
  if (!r.ok) {
    return { ok: false, error: `failed to build ${outFile}: ${r.detail ?? "unknown"}` };
  }
  if (!existsSync(outFile) || statSync(outFile).size < 1000) {
    return { ok: false, error: `build of ${outFile} produced no usable output` };
  }
  return { ok: true };
}

function runEsbuild(args: string[]): { ok: boolean; detail?: string } {
  let esbuildBin: string;
  try {
    esbuildBin = require.resolve("esbuild/bin/esbuild");
  } catch {
    return { ok: false, detail: "esbuild not installed (devDependencies)" };
  }
  const r = spawnSync(process.execPath, [esbuildBin, ...args], {
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) {
    return { ok: false, detail: (r.stderr || r.stdout || "esbuild failed").slice(0, 300) };
  }
  return { ok: true };
}

/**
 * Return a usable preload path, building the bundle on demand when missing.
 * Fail-closed: returns an error instead of a path when nothing works.
 */
export function ensureEgressPreload(): { ok: true; path: string } | { ok: false; error: string } {
  const existing = findPreloadPath();
  if (existing) return { ok: true, path: existing };

  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const src = join(root, "src", "sandbox", "egress-preload.ts");
  const outFile = join(root, "dist", "egress-preload.cjs");
  if (!existsSync(src)) {
    return { ok: false, error: `preload source not found at ${src}` };
  }
  const r = esbuildBundle(src, outFile);
  if (!r.ok) return { ok: false, error: `failed to build egress preload: ${r.error}` };
  return { ok: true, path: outFile };
}

/**
 * Return a usable sidecar bundle path, building on demand when missing.
 * Same fail-closed contract as ensureEgressPreload.
 */
export function ensureEgressSidecar(): { ok: true; path: string } | { ok: false; error: string } {
  const existing = findSidecarPath();
  if (existing) return { ok: true, path: existing };

  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const src = join(root, "src", "sandbox", "egress-sidecar.ts");
  const outFile = join(root, "dist", "egress-sidecar.cjs");
  if (!existsSync(src)) {
    return { ok: false, error: `sidecar source not found at ${src}` };
  }
  const r = esbuildBundle(src, outFile);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, path: outFile };
}
