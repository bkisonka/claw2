// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { acceptSkill, runCodeSkill } from "./run-code-skill.js";

const { create, unexpectedRun } = vi.hoisted(() => ({ create: vi.fn(), unexpectedRun: vi.fn() }));
vi.mock("../core/llm.js", async (original) => ({
  ...await original<typeof import("../core/llm.js")>(),
  createClient: () => ({ chat: { completions: { create } } }),
}));
vi.mock("../sandbox/run-agent.js", () => ({ runAgent: unexpectedRun, runAgentHost: unexpectedRun }));

const filename = "approved.js";
const header = '// Agent: draft\n// Call: run_agent({script:"approved.js"})\n// In: none\n// Out: text\n';

describe("skill drafts", () => {
  it.each([{ allowlist: [] }, { allowlist: [filename] }])("does not run drafts with $allowlist", async ({ allowlist }) => {
    const dir = mkdtempSync(join(tmpdir(), "claw2-draft-"));
    try {
      const installed = join(dir, filename);
      writeFileSync(installed, header + 'console.log("installed");');
      create.mockReset();
      unexpectedRun.mockClear();
      create.mockResolvedValueOnce({ choices: [{ message: { tool_calls: [{
        id: "write-1", type: "function", function: { name: "write", arguments: JSON.stringify({
          path: filename, content: header + 'console.log("candidate");',
        }) },
      }] } }] }).mockResolvedValueOnce({ choices: [{ message: { content: "done" } }] });
      const config = { agentsDir: dir, skills: { allowlist }, coding: { maxSubagents: 1 } };
      const result = await runCodeSkill(config, { script: filename, task: "Update text" });
      expect(JSON.parse(result.message).results).toMatchObject([{ ok: true, executed: false }]);
      expect(existsSync(join(dir, ".code_skill"))).toBe(false);
      expect(unexpectedRun).not.toHaveBeenCalled();
      expect(acceptSkill(config, result.runId!, 0).ok).toBe(true);
      expect(unexpectedRun).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
