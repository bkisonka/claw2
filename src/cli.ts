#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * CLI: user message or subcommand audit, agent-selection.
 * claw2 "message" - chat; claw2 audit [--json] - security audit;
 * claw2 agent-selection export [--task <id>] [--format markdown|yaml] — export the agent selection database.
 */

import { loadConfig } from "./config/load.js";
import { wrapExternalContent } from "./security/content-boundary.js";
import { runOrchestrator } from "./core/orchestrator.js";
import { runAudit, formatAuditReport } from "./audit/run-audit.js";
import { exportTaskToMarkdown, exportTaskToYaml, exportListTaskIds } from "./agent-selection/export.js";

const args = process.argv.slice(2);
const isAudit = args[0] === "audit";
const isJson = args[1] === "--json" || args[0] === "--json";

const isAgentSelectionExport =
  args[0] === "agent-selection" && args[1] === "export";
const exportTaskIdx = args.indexOf("--task");
const exportTaskId = exportTaskIdx >= 0 && args[exportTaskIdx + 1] ? args[exportTaskIdx + 1]! : null;
const exportFormatIdx = args.indexOf("--format");
const exportFormat = exportFormatIdx >= 0 && args[exportFormatIdx + 1] ? args[exportFormatIdx + 1]! : "markdown";

if (isAudit) {
  const config = loadConfig();
  const items = runAudit(config);
  const report = formatAuditReport(items, isJson ? "json" : "text");
  console.log(report);
  const hasError = items.some((i) => i.level === "error");
  process.exit(hasError ? 1 : 0);
}

if (isAgentSelectionExport) {
  const config = loadConfig();
  if (!exportTaskId) {
    const ids = exportListTaskIds(config);
    console.log("# Task IDs in agent-selection DB\n");
    ids.forEach((id) => console.log(id));
    if (ids.length === 0) console.log("(none)");
  } else {
    const out =
      exportFormat === "yaml"
        ? exportTaskToYaml(config, exportTaskId)
        : exportTaskToMarkdown(config, exportTaskId);
    console.log(out);
  }
  process.exit(0);
}

const rawMessage = args.join(" ").trim() || "Hello, what can you do?";

async function main() {
  const config = loadConfig();
  const wrapped = wrapExternalContent(rawMessage, { source: "cli" });

  const result = await runOrchestrator({
    config,
    userMessage: wrapped,
    onRunAgent: (script, exitCode) => {
      console.error(`[run_agent] ${script} exitCode=${exitCode}`);
    },
    onWriteAgent: (script, ok) => {
      console.error(`[write_agent] ${script} ok=${ok}`);
    },
    onStreamChunk: (chunk) => process.stdout.write(chunk),
  });

  if (result.error) console.error(result.error);
  if (result.streamed) process.stdout.write("\n");
  else if (result.content != null) console.log(result.content);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
