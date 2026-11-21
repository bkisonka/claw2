// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Context generator for the encoder model: Markdown from database data (dropped / winner).
 * Readable by both humans and models.
 */
import type { Claw2Config } from "../config/types.js";
import { getContextForTask } from "./store.js";

const MAX_CODE_CHARS = 8000;

function truncateCode(code: string, maxChars: number): string {
  if (code.length <= maxChars) return code;
  return code.slice(0, maxChars) + "\n// ... (truncated)";
}

/**
 * Collect Markdown context for the task for the encoder model prompt.
 * Sections: Task, Dropped versions (do not repeat), Current winner (prefer).
 */
export function buildContextMarkdown(
  config: Claw2Config,
  taskId: string,
  taskDescription?: string
): string {
  const { dropped, winner } = getContextForTask(config, taskId);
  const lines: string[] = [];

  lines.push(`## Task: ${taskId}`);
  if (taskDescription?.trim()) {
    lines.push("");
    lines.push(taskDescription.trim());
  }
  lines.push("");

  if (dropped.length > 0) {
    lines.push("### Dropped versions (do not repeat these approaches)");
    lines.push("");
    for (const v of dropped) {
      const reason = v.hasErrors ? "had errors" : "worse median time";
      const medianStr = v.medianDurationMs != null ? `, median ${v.medianDurationMs}ms` : "";
      lines.push(`#### Version ${v.id} — dropped ${v.droppedAt}, reason: ${reason}${medianStr}`);
      lines.push("```js");
      lines.push(truncateCode(v.code, MAX_CODE_CHARS));
      lines.push("```");
      lines.push("");
    }
  }

  if (winner) {
    lines.push("### Current winner (prefer this style, can improve)");
    const medianStr = winner.medianDurationMs != null ? ` Median time: ${winner.medianDurationMs}ms.` : "";
    lines.push("");
    lines.push(`Version ${winner.id}.${medianStr}`);
    lines.push("");
    lines.push("```js");
    lines.push(truncateCode(winner.code, MAX_CODE_CHARS));
    lines.push("```");
  } else if (dropped.length === 0) {
    lines.push("*(No previous versions for this task.)*");
  }

  return lines.join("\n");
}
