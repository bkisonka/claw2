// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Types for natural selection of agents (agent-selection).
 * Task = niche by taskId; version = one version of the agent code; run = one version run.
 */
export interface AgentSelectionTask {
  taskId: string;
  toolName: string;
  inputSchemaJson: string;
  createdAt: string;
}

export interface AgentSelectionVersion {
  id: string;
  taskId: string;
  code: string;
  createdAt: string;
  droppedAt: string | null;
}

export interface AgentSelectionRun {
  id: number;
  versionId: string;
  timestamp: string;
  durationMs: number;
  success: boolean;
  errorType: string | null;
  rating: number | null;
}

export interface VersionWithRunCount {
  id: string;
  taskId: string;
  code: string;
  createdAt: string;
  droppedAt: string | null;
  runCount: number;
}
