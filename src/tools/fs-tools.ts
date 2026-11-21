// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Read, write, edit tools for the orchestrator. Paths are checked using isPathAllowed.
 * The alias "uploads" and "uploads/..." are substituted from config.uploads.hostPath.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Claw2Config } from "../config/types.js";
import { isPathAllowed, resolvePathAliases } from "../security/path-allowed.js";

const MAX_FILE_SIZE_READ = 512 * 1024; // 512 KB
const MAX_FILE_SIZE_WRITE = 1024 * 1024; // 1 MB

function getResolvedPath(config: Claw2Config, pathArg: string): string {
  const workspaceDir = config.workspace ? resolve(config.workspace) : resolve(process.cwd());
  const trimmed = resolvePathAliases(pathArg, config);
  return trimmed.startsWith("/") ? resolve(trimmed) : resolve(workspaceDir, trimmed);
}

export function toolRead(config: Claw2Config, pathArg: string, encoding?: string): { ok: boolean; content?: string; error?: string } {
  if (!isPathAllowed(pathArg, config)) return { ok: false, error: "path not allowed" };
  const resolved = getResolvedPath(config, pathArg);
  try {
    const enc = encoding === "base64" ? "base64" : "utf-8";
    const content = readFileSync(resolved, enc);
    if (typeof content === "string" && content.length > MAX_FILE_SIZE_READ) {
      return { ok: false, error: `file too large (max ${MAX_FILE_SIZE_READ} bytes)` };
    }
    return { ok: true, content: typeof content === "string" ? content : Buffer.from(content).toString(enc) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function toolWrite(config: Claw2Config, pathArg: string, content: string, encoding?: string): { ok: boolean; error?: string } {
  if (!isPathAllowed(pathArg, config)) return { ok: false, error: "path not allowed" };
  const resolved = getResolvedPath(config, pathArg);
  if (Buffer.byteLength(content, "utf-8") > MAX_FILE_SIZE_WRITE) {
    return { ok: false, error: `content too large (max ${MAX_FILE_SIZE_WRITE} bytes)` };
  }
  try {
    mkdirSync(dirname(resolved), { recursive: true });
    const enc = encoding === "base64" ? "base64" : "utf-8";
    writeFileSync(resolved, content, enc);
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
  if (!isPathAllowed(pathArg, config)) return { ok: false, error: "path not allowed" };
  const resolved = getResolvedPath(config, pathArg);
  try {
    const content = readFileSync(resolved, "utf-8");
    const newContent = content.split(searchText).join(replaceText);
    if (Buffer.byteLength(newContent, "utf-8") > MAX_FILE_SIZE_WRITE) {
      return { ok: false, error: `result too large (max ${MAX_FILE_SIZE_WRITE} bytes)` };
    }
    writeFileSync(resolved, newContent, "utf-8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function toolListDir(
  config: Claw2Config,
  pathArg: string
): { ok: boolean; entries?: string[]; error?: string } {
  if (!isPathAllowed(pathArg, config)) return { ok: false, error: "path not allowed" };
  const resolved = getResolvedPath(config, pathArg);
  try {
    const st = statSync(resolved);
    if (!st.isDirectory()) return { ok: false, error: "not a directory" };
    const entries = readdirSync(resolved);
    return { ok: true, entries };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
