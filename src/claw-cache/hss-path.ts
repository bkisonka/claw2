/**
 * Resolve path to hss.cjs (repo root in dev, claw2-runtime root when packaged).
 */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/** Candidates: CLAW2_REPO_ROOT, cwd, two levels up from dist/claw-cache (packaged + monorepo). */
export function resolveHssCjsPath(): string | null {
  const candidates = [
    process.env.CLAW2_REPO_ROOT?.trim()
      ? resolve(process.env.CLAW2_REPO_ROOT.trim(), "hss.cjs")
      : null,
    resolve(process.cwd(), "hss.cjs"),
    // dist/claw-cache → ../../hss.cjs = repo root or claw2-runtime/
    join(here, "..", "..", "hss.cjs"),
  ].filter((p): p is string => Boolean(p));

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0] ?? resolve(process.cwd(), "hss.cjs");
}

export function loadHssModule<T = unknown>(): { mod: T; path: string } | null {
  const path = resolveHssCjsPath();
  if (!path || !existsSync(path)) return null;
  try {
    return { mod: require(path) as T, path };
  } catch {
    return null;
  }
}
