// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Selection algorithm and choice of version to launch.
 * Task = model user request (there is no such thing as a “bat”). The agent (version) performs the task and may be damaged.
 * After 5 runs: weed out versions of agents with errors, the best by median time, set the rest to dropped_at.
 * When requesting a task: random selection among agent versions with < 5 runs.
 */
import type { Claw2Config } from "../config/types.js";
import { writeAgent } from "../agents/write-agent.js";
import { generateAgentCode } from "./coding-model.js";
import { selectionLog } from "./log.js";
import {
  getActiveVersionCountForTask,
  getDb,
  getTaskScriptName,
  getVersionsWithLessThan5Runs,
  insertRun,
  insertVersion,
  setVersionsDropped,
} from "./store.js";

const RUNS_PER_VERSION_DEFAULT = 5;

function median(arr: number[]): number | undefined {
  if (arr.length === 0) return undefined;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid];
}

/**
 * Randomly select a version of the task that has fewer than 5 runs.
 * Returns null if there are no such versions (or selection is disabled).
 */
export function pickVersionForRun(
  config: Claw2Config,
  taskId: string
): { versionId: string; code: string; candidateCount: number; runCount: number } | null {
  if (!config.agentSelection?.enabled) return null;
  const runsPerVersion = config.agentSelection.runsPerVersion ?? RUNS_PER_VERSION_DEFAULT;
  const candidates = getVersionsWithLessThan5Runs(config, taskId, runsPerVersion);
  if (candidates.length === 0) {
    selectionLog(config, "skip_pick", {
      taskId,
      reason: "no_candidates_under_runs_cap",
      runsPerVersion,
      activeVersions: getActiveVersionCountForTask(config, taskId),
    });
    return null;
  }
  const idx = Math.floor(Math.random() * candidates.length);
  const v = candidates[idx]!;
  selectionLog(config, "pick", {
    taskId,
    versionId: v.id,
    runCount: v.runCount,
    candidateCount: candidates.length,
    runsPerVersion,
    codeChars: v.code.length,
  });
  return {
    versionId: v.id,
    code: v.code,
    candidateCount: candidates.length,
    runCount: v.runCount,
  };
}

/**
 * Record the launch result and, if necessary, perform a selection.
 * A broken agent (version with success === false) is dropped immediately. If there is no active agent version left for a task, the generation of a new agent is started based on the task data (encoder model).
 */
export async function recordRunAndMaybeSelect(
  config: Claw2Config,
  taskId: string,
  versionId: string,
  durationMs: number,
  success: boolean,
  errorType?: string | null,
  rating?: number | null
): Promise<number | null> {
  if (!config.agentSelection?.enabled) return null;
  const runId = insertRun(config, versionId, durationMs, success, errorType ?? null, rating ?? null);
  selectionLog(config, "run", {
    taskId,
    versionId,
    runId,
    durationMs,
    success,
    errorType: errorType ?? undefined,
  });
  if (!success) {
    setVersionsDropped(config, [versionId]);
    selectionLog(config, "drop", {
      taskId,
      versionIds: [versionId],
      reason: "run_failed",
      errorType: errorType ?? undefined,
    });
    const remaining = getActiveVersionCountForTask(config, taskId);
    if (remaining === 0 && config.agentSelection?.codingModel?.model) {
      const script = getTaskScriptName(config, taskId);
      if (script) {
        selectionLog(config, "regen", {
          taskId,
          script,
          reason: "all_versions_dropped",
        });
        const taskDescription = `Agent script: ${script}. Regenerate after all versions were dropped (e.g. due to failures).`;
        const code = await generateAgentCode(config, taskId, taskDescription);
        if (code) {
          const newId = insertVersion(config, taskId, code);
          writeAgent(config, { script, content: code });
          selectionLog(config, "version_added", {
            taskId,
            versionId: newId,
            script,
            source: "regen_after_total_drop",
            codeChars: code.length,
          });
        } else {
          selectionLog(config, "regen_failed", {
            taskId,
            script,
            reason: "coding_model_returned_null",
          });
        }
      }
    }
  }
  runSelectionForTaskIfReady(config, taskId);
  return runId;
}

/**
 * If all active versions of a task have 5 runs: weed out those with errors,
 * choose the best one based on the median time, set the rest to dropped_at.
 */
export function runSelectionForTaskIfReady(config: Claw2Config, taskId: string): void {
  if (!config.agentSelection?.enabled) return;
  const runsPerVersion = config.agentSelection.runsPerVersion ?? RUNS_PER_VERSION_DEFAULT;
  const db = getDb(config);

  const versions = db
    .prepare(
      `SELECT v.id, v.dropped_at, COUNT(r.id) AS run_count
       FROM versions v
       LEFT JOIN runs r ON r.version_id = v.id
       WHERE v.task_id = ? AND v.dropped_at IS NULL
       GROUP BY v.id
       HAVING run_count >= ?`
    )
    .all(taskId, runsPerVersion) as Array<{ id: string; dropped_at: string | null; run_count: number }>;

  if (versions.length === 0) return;

  const allActive = db
    .prepare(`SELECT id FROM versions WHERE task_id = ? AND dropped_at IS NULL`)
    .all(taskId) as Array<{ id: string }>;
  const activeIds = new Set(allActive.map((r) => r.id));
  const allHave5 =
    activeIds.size > 0 &&
    [...activeIds].every((id) => {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM runs WHERE version_id = ?`).get(id) as {
        c: number;
      };
      return row.c >= runsPerVersion;
    });
  if (!allHave5) return;

  type VersionStats = { id: string; medianMs: number; hasErrors: boolean };
  const stats: VersionStats[] = [];
  for (const vid of activeIds) {
    const runs = db
      .prepare(`SELECT duration_ms, success FROM runs WHERE version_id = ? ORDER BY timestamp ASC`)
      .all(vid) as Array<{ duration_ms: number; success: number }>;
    const hasErrors = runs.some((r) => r.success === 0);
    const durations = runs.filter((r) => r.success === 1).map((r) => r.duration_ms);
    const medianMs = median(durations);
    if (medianMs != null) stats.push({ id: vid, medianMs, hasErrors });
  }

  const withoutErrors = stats.filter((s) => !s.hasErrors);
  if (withoutErrors.length === 0) {
    const ids = stats.map((s) => s.id);
    setVersionsDropped(config, ids);
    selectionLog(config, "drop", {
      taskId,
      versionIds: ids,
      reason: "all_had_errors_after_full_runs",
    });
    return;
  }

  const best = withoutErrors.reduce((a, b) => (a.medianMs <= b.medianMs ? a : b));
  const toDrop = stats.filter((s) => s.id !== best.id).map((s) => s.id);
  setVersionsDropped(config, toDrop);
  selectionLog(config, "winner", {
    taskId,
    versionId: best.id,
    medianMs: best.medianMs,
    dropped: toDrop,
    activeBefore: activeIds.size,
  });
  if (toDrop.length > 0) {
    selectionLog(config, "drop", {
      taskId,
      versionIds: toDrop,
      reason: "lost_to_winner",
      winnerId: best.id,
    });
  }
}
