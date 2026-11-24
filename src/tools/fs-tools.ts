// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Read, write, edit tools for the orchestrator. Paths are checked using isPathAllowed.
 * The alias "uploads" and "uploads/..." are substituted from config.uploads.hostPath.
 *
 * Skill-writable mounts (agents/output, agents/uploads) may contain planted
 * symlinks, so after the lexical authorization every fs operation additionally
 * verifies the physical path (safeRealPath — symlink components are rejected)
 * and re-checks authorization on the canonical path, then opens the final
 * component with O_NOFOLLOW (closing the check-then-open race where available).
 */
import {
  constants as fsConstants,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { Claw2Config } from "../config/types.js";
import { isPathAllowed, resolvePathAliases } from "../security/path-allowed.js";
import { noFollowFlag, safeRealPath, verifyComponents } from "../security/safe-fs.js";

const MAX_FILE_SIZE_READ = 512 * 1024; // 512 KB
const MAX_FILE_SIZE_WRITE = 1024 * 1024; // 1 MB
/** Whole file that may be opened when the model pages through it with offset/limit. */
const MAX_PAGED_FILE_BYTES = 8 * 1024 * 1024;
/** Lines per read(offset, limit) call. */
const DEFAULT_READ_LINES = 2000;
const MAX_READ_LINES = 5000;

const O_RDONLY = fsConstants.O_RDONLY ?? 0;
const O_WRONLY = fsConstants.O_WRONLY ?? 0;
const O_CREAT = fsConstants.O_CREAT ?? 0;
const O_TRUNC = fsConstants.O_TRUNC ?? 0;

function getResolvedPath(config: Claw2Config, pathArg: string): string {
  const workspaceDir = config.workspace ? resolve(config.workspace) : resolve(process.cwd());
  const trimmed = resolvePathAliases(pathArg, config);
  return trimmed.startsWith("/") ? resolve(trimmed) : resolve(workspaceDir, trimmed);
}

/**
 * Authorize the lexical path, then the physical one: reject symlink
 * components and re-authorize the canonical path (a link must not redirect
 * an allowed path to a disallowed location).
 */
function resolveSafePath(
  config: Claw2Config,
  pathArg: string
): { path: string; error?: string; components?: { path: string; dev: number; ino: number }[] } {
  if (!isPathAllowed(pathArg, config)) return { path: "", error: "path not allowed" };
  const lexical = getResolvedPath(config, pathArg);
  const real = safeRealPath(lexical);
  if (!real.ok) return { path: "", error: `unsafe path: ${real.error ?? "unresolvable"}` };
  // Canonical path must satisfy the same policy (defense in depth: mounts and
  // canonicalization may move the path — it must stay within the same roots).
  if (!isPathAllowed(real.path, config)) return { path: "", error: "path not allowed" };
  return { path: real.path, components: real.components };
}

/** Line window for read(): offset is 1-based, both optional. */
export interface ReadLines {
  offset?: number;
  limit?: number;
}

function wholeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
}

/** The requested line window of a text file, with a header saying which lines came back. */
function sliceLines(text: string, lines: ReadLines): { ok: boolean; content?: string; error?: string } {
  if (!text) return { ok: true, content: "[file is empty]" };
  // A trailing newline ends the last line; it does not start an empty one.
  const all = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const start = Math.max(1, wholeNumber(lines.offset, 1));
  // Said outright: the last line again would read as if there were more.
  if (start > all.length) return { ok: true, content: `[no lines at offset ${start}: the file has ${all.length}]` };
  const take = Math.min(Math.max(1, wholeNumber(lines.limit, DEFAULT_READ_LINES)), MAX_READ_LINES);
  const slice = all.slice(start - 1, start - 1 + take);
  const content = `[lines ${start}-${start + slice.length - 1} of ${all.length}]\n${slice.join("\n")}`;
  if (content.length > MAX_FILE_SIZE_READ) {
    return { ok: false, error: `line range too large (max ${MAX_FILE_SIZE_READ} characters); lower limit` };
  }
  return { ok: true, content };
}

export function toolRead(
  config: Claw2Config,
  pathArg: string,
  encoding?: string,
  lines?: ReadLines
): { ok: boolean; content?: string; error?: string } {
  const safe = resolveSafePath(config, pathArg);
  if (safe.error) return { ok: false, error: safe.error };
  try {
    if (!verifyComponents(safe.components)) return { ok: false, error: "path changed during access (possible symlink swap)" };
    const enc = encoding === "base64" ? "base64" : "utf-8";
    const paged = enc === "utf-8" && !!lines && (lines.offset != null || lines.limit != null);
    // Checked before reading: a multi-gigabyte file must not be loaded just to be refused.
    if (statSync(safe.path).size > MAX_PAGED_FILE_BYTES) {
      return { ok: false, error: `file too large (max ${MAX_PAGED_FILE_BYTES} bytes)` };
    }
    // Numeric flag is valid at runtime; @types/node admits strings only.
    const content = readFileSync(safe.path, {
      encoding: enc as BufferEncoding,
      flag: noFollowFlag(O_RDONLY) as unknown as string,
    });
    const text = typeof content === "string" ? content : Buffer.from(content).toString(enc);
    if (paged) return sliceLines(text, lines);
    if (text.length > MAX_FILE_SIZE_READ) {
      return {
        ok: false,
        error: `file too large (max ${MAX_FILE_SIZE_READ} characters); read it in parts with offset and limit`,
      };
    }
    return { ok: true, content: text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function toolWrite(config: Claw2Config, pathArg: string, content: string, encoding?: string): { ok: boolean; error?: string } {
  const safe = resolveSafePath(config, pathArg);
  if (safe.error) return { ok: false, error: safe.error };
  if (Buffer.byteLength(content, "utf-8") > MAX_FILE_SIZE_WRITE) {
    return { ok: false, error: `content too large (max ${MAX_FILE_SIZE_WRITE} bytes)` };
  }
  try {
    mkdirSync(dirname(safe.path), { recursive: true });
    // The target dir may have been created through a planted symlink — re-verify.
    const re = safeRealPath(safe.path);
    if (!re.ok || !verifyComponents(re.components)) {
      return { ok: false, error: `unsafe path: ${re.error ?? "path changed during access"}` };
    }
    const enc = encoding === "base64" ? "base64" : "utf-8";
    writeFileSync(re.path, content, {
      encoding: enc === "base64" ? "base64" : "utf-8",
      mode: 0o600,
      flag: noFollowFlag(O_WRONLY | O_CREAT | O_TRUNC) as unknown as string,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function toolEdit(
  config: Claw2Config,
  pathArg: string,
  searchText: string,
  replaceText: string
): { ok: boolean; error?: string } {
  const safe = resolveSafePath(config, pathArg);
  if (safe.error) return { ok: false, error: safe.error };
  try {
    if (!verifyComponents(safe.components)) return { ok: false, error: "path changed during access (possible symlink swap)" };
    const content = readFileSync(safe.path, {
      encoding: "utf-8",
      flag: noFollowFlag(O_RDONLY) as unknown as string,
    });
    const newContent = content.split(searchText).join(replaceText);
    if (Buffer.byteLength(newContent, "utf-8") > MAX_FILE_SIZE_WRITE) {
      return { ok: false, error: `result too large (max ${MAX_FILE_SIZE_WRITE} bytes)` };
    }
    writeFileSync(safe.path, newContent, {
      encoding: "utf-8",
      mode: 0o600,
      flag: noFollowFlag(O_WRONLY | O_TRUNC) as unknown as string,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function toolListDir(
  config: Claw2Config,
  pathArg: string
): { ok: boolean; entries?: string[]; error?: string } {
  const safe = resolveSafePath(config, pathArg);
  if (safe.error) return { ok: false, error: safe.error };
  try {
    if (!verifyComponents(safe.components)) return { ok: false, error: "path changed during access (possible symlink swap)" };
    const st = statSync(safe.path);
    if (!st.isDirectory()) return { ok: false, error: "not a directory" };
    const entries = readdirSync(safe.path);
    return { ok: true, entries };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
