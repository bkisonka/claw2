#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Sync docs/wiki/{en,ru} → wiki/pages/{en,ru}: the shipped in-app wiki is a
 * copy of the source docs; without this step new guides silently never reach
 * the deployment (the 0.2.14 companion guide was the caught case).
 */
import { cpSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "docs", "wiki");
const dst = join(root, "wiki", "pages");

for (const lang of readdirSync(src).filter((d) => d === "en" || d === "ru")) {
  const from = join(src, lang);
  const to = join(dst, lang);
  if (existsSync(to)) rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  console.log(`wiki: docs/wiki/${lang} → wiki/pages/${lang}`);
}
