// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Claw2Config } from "../config/types.js";
import { toolRead } from "./fs-tools.js";

let dir: string;
let uploads: string;
let config: Claw2Config;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claw2-fs-tools-test-"));
  uploads = join(dir, "uploads");
  mkdirSync(uploads, { recursive: true });
  config = { uploads: { hostPath: uploads } } as Claw2Config;
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe("read paging", () => {
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);

  beforeEach(() => {
    writeFileSync(join(uploads, "lines.txt"), lines.join("\n"));
  });

  it("returns the whole file when no window is given", () => {
    expect(toolRead(config, "uploads/lines.txt")).toEqual({ ok: true, content: lines.join("\n") });
  });

  it("returns the requested line window with a header", () => {
    expect(toolRead(config, "uploads/lines.txt", undefined, { offset: 3, limit: 4 })).toEqual({
      ok: true,
      content: "[lines 3-6 of 12]\nline 3\nline 4\nline 5\nline 6",
    });
    expect(toolRead(config, "uploads/lines.txt", undefined, { offset: 10 })).toEqual({
      ok: true,
      content: "[lines 10-12 of 12]\nline 10\nline 11\nline 12",
    });
  });

  it("clamps the window to the file and to the line cap", () => {
    const beyond = toolRead(config, "uploads/lines.txt", undefined, { offset: 99, limit: 5 });
    expect(beyond).toEqual({ ok: true, content: "[lines 12-12 of 12]\nline 12" });
    const fromStart = toolRead(config, "uploads/lines.txt", undefined, { limit: 999_999 }) as { ok: boolean; content: string };
    expect(fromStart.ok).toBe(true);
    expect(fromStart.content.startsWith("[lines 1-12 of 12]\n")).toBe(true);
  });

  it("does not count a trailing newline as an empty last line", () => {
    writeFileSync(join(uploads, "unix.txt"), "alpha\nbeta\ngamma\n");
    expect(toolRead(config, "uploads/unix.txt", undefined, { offset: 3 })).toEqual({
      ok: true,
      content: "[lines 3-3 of 3]\ngamma",
    });
    writeFileSync(join(uploads, "empty.txt"), "");
    expect(toolRead(config, "uploads/empty.txt", undefined, { offset: 1, limit: 10 })).toEqual({
      ok: true,
      content: "[file is empty]",
    });
  });

  it("reads parts of a file that is too large to return whole", () => {
    const big = Array.from({ length: 20_000 }, (_, i) => `row ${i + 1} ${"v".repeat(40)}`);
    writeFileSync(join(uploads, "big.txt"), big.join("\n"));
    const whole = toolRead(config, "uploads/big.txt");
    expect(whole.ok).toBe(false);
    expect(whole.error).toContain("read it in parts with offset and limit");
    const page = toolRead(config, "uploads/big.txt", undefined, { offset: 19_998, limit: 100 });
    expect(page).toEqual({ ok: true, content: `[lines 19998-20000 of 20000]\n${big.slice(19_997).join("\n")}` });
  });

  it("refuses a file that is too large even for paging", () => {
    writeFileSync(join(uploads, "huge.bin"), Buffer.alloc(8 * 1024 * 1024 + 1));
    expect(toolRead(config, "uploads/huge.bin", undefined, { offset: 1, limit: 5 })).toMatchObject({
      ok: false,
      error: "file too large (max 8388608 bytes)",
    });
  });

  it("ignores the window for base64 and keeps the path checks", () => {
    const b64 = toolRead(config, "uploads/lines.txt", "base64", { offset: 3, limit: 4 });
    expect(b64).toEqual({ ok: true, content: Buffer.from(lines.join("\n")).toString("base64") });
    expect(toolRead(config, "../../etc/passwd", undefined, { offset: 1 })).toEqual({ ok: false, error: "path not allowed" });
  });
});
