// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Symlink-safe filesystem operations for paths that may contain
 * attacker-controlled components (skill-writable mounts: agents/output,
 * agents/uploads are bind-mounted into the skill sandbox).
 *
 * Lexical checks (resolve/relative) authorize the path but do not see
 * symlinks: a link planted inside a skill-writable directory redirects any
 * subsequent open to an arbitrary location, resolved with the gateway's
 * privileges. Defense here has two layers:
 *
 *  1. Component walk: every existing component of the path is lstat'ed; a
 *     symlink anywhere (including intermediate directories) rejects the path.
 *     The deepest fully-existing prefix is canonicalized with realpathSync;
 *     the remaining not-yet-existing components are appended lexically
 *     (they cannot be symlinks — nothing is there yet).
 *  2. O_NOFOLLOW on the final open where the platform provides it, closing
 *     the check-then-open race on the last component.
 *
 * The caller still runs its own authorization (isPathAllowed) first — this
 * module is the "what will the kernel actually open" guarantee, not an
 * access-control list.
 */
import { constants as fsConstants, lstatSync, realpathSync } from "node:fs";
import { parse, resolve } from "node:path";

export interface SafeRealPath {
  ok: boolean;
  /** Canonical path: deepest existing prefix realpath'ed + the lexical tail. */
  path: string;
  error?: string;
}

/** O_NOFOLLOW is POSIX; on platforms without it the flag is a no-op (0). */
const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/** Open flags for reading/writing the FINAL component without following a symlink. */
export function noFollowFlag(base: number): number {
  return base | O_NOFOLLOW;
}

/**
 * Canonicalize `resolved` (absolute) rejecting symlink components.
 * The path does not have to exist; every component that exists must not be
 * a symlink.
 */
export function safeRealPath(resolved: string): SafeRealPath {
  const abs = resolve(resolved);
  const parsed = parse(abs);
  const rel = abs.slice(parsed.root.length);
  const parts = rel.split(/[/\\]/).filter(Boolean);
  let built = parsed.root;
  let lastExisting = parsed.root;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const candidate = built.endsWith("/") ? built + part : `${built}/${part}`;
    let st: { isSymbolicLink(): boolean };
    try {
      st = lstatSync(candidate);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        // Nothing exists at this component (or a parent stopped being a
        // directory): append the remaining tail lexically onto the deepest
        // existing prefix, canonicalized. Nothing there can be a symlink yet.
        let canonical: string;
        try {
          canonical = realpathSync(lastExisting);
        } catch {
          canonical = lastExisting;
        }
        let out = canonical;
        for (let j = i; j < parts.length; j++) {
          out = out.endsWith("/") ? out + parts[j] : `${out}/${parts[j]}`;
        }
        return { ok: true, path: out };
      }
      return { ok: false, path: candidate, error: err instanceof Error ? err.message : String(err) };
    }
    if (st.isSymbolicLink()) {
      return { ok: false, path: candidate, error: `symlink component in path: ${candidate}` };
    }
    built = candidate;
    lastExisting = built;
  }
  // Every component exists and none is a symlink: canonicalize (mounts,
  // case normalization) and return. realpath cannot escape here — no links.
  try {
    return { ok: true, path: realpathSync(lastExisting) };
  } catch (err) {
    return { ok: false, path: lastExisting, error: err instanceof Error ? err.message : String(err) };
  }
}

export { O_NOFOLLOW };
export { resolve };
