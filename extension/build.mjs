// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Build the companion extension into extension/dist/ (load-unpacked ready):
 * content.js (classic script for the page), background.js (ES module service
 * worker), options page, manifest. Works with esbuild installed either in
 * extension/node_modules or in the repo root node_modules.
 */
import { createRequire } from "node:module";
import { cpSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(import.meta.url));

function resolveEsbuild() {
  for (const candidate of ["esbuild", join(root, "node_modules", "esbuild"), join(root, "..", "node_modules", "esbuild")]) {
    try {
      return require(candidate);
    } catch {
      /* try the next location */
    }
  }
  throw new Error("esbuild not found: run npm install in extension/ (or in the repo root)");
}

const esbuild = resolveEsbuild();
const out = join(root, "dist");
mkdirSync(out, { recursive: true });

await esbuild.build({
  entryPoints: [join(root, "src/content.ts")],
  bundle: true,
  format: "iife",
  target: ["chrome120"],
  outfile: join(out, "content.js"),
  legalComments: "none",
});

await esbuild.build({
  entryPoints: [join(root, "src/background.ts")],
  bundle: true,
  format: "esm",
  target: ["chrome120"],
  outfile: join(out, "background.js"),
  legalComments: "none",
});

await esbuild.build({
  entryPoints: [join(root, "src/options.ts")],
  bundle: true,
  format: "iife",
  target: ["chrome120"],
  outfile: join(out, "options.js"),
  legalComments: "none",
});

cpSync(join(root, "manifest.json"), join(out, "manifest.json"));
cpSync(join(root, "options.html"), join(out, "options.html"));

console.log("claw2 companion → extension/dist/ (load unpacked)");
