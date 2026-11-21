// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import assert from "node:assert/strict";
import { parseAgentHeader, getAvailableAgents } from "./list.js";
import { formatSkillHeader } from "./skill-header.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

{
  const parsed = parseAgentHeader(`// Agent: save text to DOCX
// Call: run_agent(script="save-docx.js", stdin="…")
// Input: stdin = full document text
// Output: FILE_URL=/files/output/….docx

import x from "y";
`);
  assert.equal(parsed.description, "save text to DOCX");
  assert.match(parsed.help, /stdin/);
  assert.match(parsed.help, /FILE_URL/);
}

{
  const dir = mkdtempSync(join(tmpdir(), "claw2-agents-"));
  try {
    writeFileSync(
      join(dir, "save-docx.js"),
      formatSkillHeader({
        description: "docx",
        call: 'run_agent({script:"save-docx.js", stdin:"…"})',
        input: "stdin=document text",
        output: "FILE_URL=/files/output/….docx",
      }) + "console.log(1);\n"
    );
    const list = getAvailableAgents(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "save-docx.js");
    assert.equal(list[0].description, "docx");
    assert.equal(list[0].usageComplete, true);
    assert.match(list[0].help, /run_agent/);
    assert.match(list[0].help, /FILE_URL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("agents/list.test.ts: ok");
