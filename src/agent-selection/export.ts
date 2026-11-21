// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Export natural selection data for humans: Markdown or YAML.
 * Readable in the editor and for debugging.
 */
import { stringify as stringifyYaml } from "yaml";
import type { Claw2Config } from "../config/types.js";
import { buildContextMarkdown } from "./context-markdown.js";
import { getDb, listTaskIds } from "./store.js";

/**
 * Export one task to Markdown (same format as the context for the encoder model).
 */
export function exportTaskToMarkdown(
  config: Claw2Config,
  taskId: string,
  taskDescription?: string
): string {
  return buildContextMarkdown(config, taskId, taskDescription);
}

/**
 * Export one task to YAML: versions, runs, metrics.
 */
export function exportTaskToYaml(config: Claw2Config, taskId: string): string {
  const db = getDb(config);
  const task = db.prepare(`SELECT task_id, tool_name, input_schema_json, created_at FROM tasks WHERE task_id = ?`).get(taskId) as
    | { task_id: string; tool_name: string; input_schema_json: string; created_at: string }
    | undefined;
  if (!task) return `# Task ${taskId}: not found\n`;

  const versions = db
    .prepare(`SELECT id, code, created_at, dropped_at FROM versions WHERE task_id = ? ORDER BY created_at`)
    .all(taskId) as Array<{ id: string; code: string; created_at: string; dropped_at: string | null }>;

  const out: Record<string, unknown> = {
    taskId: task.task_id,
    toolName: task.tool_name,
    inputSchemaJson: task.input_schema_json,
    createdAt: task.created_at,
    versions: versions.map((v) => {
      const runs = db
        .prepare(`SELECT timestamp, duration_ms, success, error_type, rating FROM runs WHERE version_id = ? ORDER BY timestamp`)
        .all(v.id) as Array<{ timestamp: string; duration_ms: number; success: number; error_type: string | null; rating: number | null }>;
      return {
        id: v.id,
        createdAt: v.created_at,
        droppedAt: v.dropped_at,
        runCount: runs.length,
        runs: runs.map((r) => ({
          timestamp: r.timestamp,
          durationMs: r.duration_ms,
          success: r.success === 1,
          errorType: r.error_type,
          rating: r.rating,
        })),
        code: v.code.length > 500 ? v.code.slice(0, 500) + "\n..." : v.code,
      };
    }),
  };
  return "# Agent selection export (YAML)\n\n" + stringifyYaml(out);
}

/**
 * List of taskIds for export (all tasks in the database).
 */
export function exportListTaskIds(config: Claw2Config): string[] {
  return listTaskIds(config);
}
