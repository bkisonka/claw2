// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import assert from "node:assert/strict";
import {
  formatSkillHeader,
  parseSkillHeader,
  validateSkillSource,
  inferSkillUsage,
  replaceSkillHeader,
} from "./skill-header.js";
import { parseAgentHeader, getAvailableAgents } from "./list.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

{
  const src = formatSkillHeader({
    description: "docx",
    call: 'run_agent({script:"save-docx.js", stdin:"…"})',
    input: "stdin=document text",
    output: "FILE_URL=/files/output/….docx",
  });
  const p = parseSkillHeader(src + "\nconsole.log(1);\n");
  assert.equal(p.complete, true);
  assert.match(p.help, /stdin/);
  assert.equal(validateSkillSource("save-docx.js", src + "\nx\n").ok, true);
}

{
  const bad = "// Agent: only\nconsole.log(1);\n";
  const v = validateSkillSource("x.js", bad);
  assert.equal(v.ok, false);
}

{
  const raw = `// Agent: chart
import fs from "node:fs";
process.stdin.on("data", () => {});
console.log("FILE_URL=/files/output/a.png");
`;
  const inferred = inferSkillUsage("chart.js", raw);
  assert.match(inferred.call, /stdin/);
  assert.match(inferred.output, /FILE_URL/);
  const next = replaceSkillHeader(raw, inferred);
  assert.equal(parseSkillHeader(next).complete, true);
}

{
  const parsed = parseAgentHeader(`// Agent: save text to DOCX
// Call: run_agent({script:"save-docx.js", stdin:"…"})
// In: stdin
// Out: FILE_URL
`);
  assert.equal(parsed.description, "save text to DOCX");
  assert.match(parsed.help, /FILE_URL/);
}

{
  const dir = mkdtempSync(join(tmpdir(), "claw2-agents-"));
  try {
    writeFileSync(
      join(dir, "save-docx.js"),
      formatSkillHeader({
        description: "docx",
        call: 'run_agent({script:"save-docx.js", stdin:"t"})',
        input: "stdin",
        output: "FILE_URL",
      }) + "console.log(1);\n"
    );
    const list = getAvailableAgents(dir);
    assert.equal(list[0].usageComplete, true);
    assert.equal(list[0].help.includes("Call:") || list[0].help.includes("run_agent"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("skill-header + list tests: ok");
