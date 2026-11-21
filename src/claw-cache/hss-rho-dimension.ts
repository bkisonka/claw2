// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Dynamic ρ matrix dimension: 4 → 8 → 11 as capacity C grows.
 */

import type { Claw2Config } from "../config/types.js";

export const RHO_DIM_BASE = 4;
export const RHO_DIM_MID = 8;
export const RHO_DIM_FULL = 11;

export interface RhoDimensionConfig {
  base: number;
  mid: number;
  full: number;
  capacityThresholdMid: number;
  capacityThresholdFull: number;
}

export function getRhoDimensionConfig(config: Claw2Config): RhoDimensionConfig {
  const cfg = config.orchestrator?.hssFieldOntology;
  return {
    base: typeof cfg?.rhoDimBase === "number" ? cfg.rhoDimBase : RHO_DIM_BASE,
    mid: typeof cfg?.rhoDimMid === "number" ? cfg.rhoDimMid : RHO_DIM_MID,
    full: typeof cfg?.rhoDimFull === "number" ? cfg.rhoDimFull : RHO_DIM_FULL,
    capacityThresholdMid:
      typeof cfg?.capacityThresholdMid === "number" ? cfg.capacityThresholdMid : 0.18,
    capacityThresholdFull:
      typeof cfg?.capacityThresholdFull === "number" ? cfg.capacityThresholdFull : 0.35,
  };
}

/**
 * Target dim ρ in terms of node capacity C and effective field dimension d.
 * Growth only (do not reduce dim in the session).
 */
export function resolveTargetRhoDim(
  capacity: number,
  effectiveDim: number,
  currentDim: number,
  config: Claw2Config
): number {
  const c = getRhoDimensionConfig(config);
  let target = c.base;
  if (capacity >= c.capacityThresholdMid && effectiveDim >= 4) target = c.mid;
  if (capacity >= c.capacityThresholdFull && effectiveDim >= 6) target = c.full;
  return Math.max(currentDim, target);
}

export function rhoDimFromMatrix(rho: { re?: number[][] } | null | undefined): number {
  if (!rho?.re?.length) return RHO_DIM_BASE;
  return rho.re.length;
}
