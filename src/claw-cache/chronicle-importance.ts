// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import type { Claw2Config } from "../config/types.js";

/** Chronicle recording source.*/
export type ChronicleEntrySource = "auto" | "model";

export function clampImportance(value: unknown, fallback = 0.5): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
    const low = value.trim().toLowerCase();
    if (low === "low" || low === "низкая" || low === "низкий") return 0.25;
    if (low === "medium" || low === "средняя" || low === "средний") return 0.5;
    if (low === "high" || low === "высокая" || low === "высокий") return 0.75;
    if (low === "critical" || low === "критическая" || low === "критично") return 0.95;
  }
  return Math.max(0, Math.min(1, fallback));
}

export function getDefaultAutoChronicleImportance(config: Claw2Config): number {
  const v = config.orchestrator?.hssChronicleRecall?.defaultAutoImportance;
  return typeof v === "number" && v >= 0 && v <= 1 ? v : 0.35;
}

export function getDefaultModelChronicleImportance(config: Claw2Config): number {
  const v = config.orchestrator?.hssChronicleRecall?.defaultModelImportance;
  return typeof v === "number" && v >= 0 && v <= 1 ? v : 0.7;
}

/** Weighted score: similarity × (base + scale × importance).*/
export function chronicleRecallScore(similarity: number, importance: number, config: Claw2Config): number {
  const base = config.orchestrator?.hssChronicleRecall?.importanceScoreBase ?? 0.4;
  const scale = config.orchestrator?.hssChronicleRecall?.importanceScoreScale ?? 0.6;
  const imp = clampImportance(importance, 0.5);
  return similarity * (base + scale * imp);
}
