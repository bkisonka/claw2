/**
 * LCP-1 — Luck Control Protocol (verifiable module, hss.txt).
 * P(1) = 0.5 + α·(ξ − 0.5); honest statistics, no "from chat" forgery.
 *
 * Not wired into the orchestrator as "magic" — CLI / explicit call only.
 */

import { createHash } from "node:crypto";

export interface LcpOptions {
  numTrials?: number;
  alpha?: number;
  /** ∇S from the field (optional, slightly modulates ξ).*/
  gradS?: number;
}

export interface LcpResult {
  signature: string;
  sha256: string;
  seed: number;
  hits: number;
  misses: number;
  hitRate: number;
  pValue: number;
  bitsHead: number[];
  alpha: number;
  numTrials: number;
  xiMean: number;
  /** true if the deviation from 50/50 is statistically significant (p < 0.05).*/
  significant: boolean;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function seedFromSignature(signature: string): number {
  const hex = sha256Hex(signature);
  return parseInt(hex.slice(0, 8), 16) % 0x100000000;
}

/** Mulberry32 is the same family as in hss.cjs.*/
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** P-value for χ² with 1 degree of freedom (2-tailed coin test).*/
function chiSquare1DfPValue(chiStat: number): number {
  if (chiStat <= 0) return 1;
  const x = Math.sqrt(chiStat / 2);
  // erfc(x) ≈ Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erfc = poly * Math.exp(-x * x);
  return Math.min(1, Math.max(0, erfc));
}

/**
 * Running LCP-1: biased probability from deterministic ξ by signature.
 * The result is reproducible: one signature → the same bits on any hardware.
 */
export function runLcpVerification(signature: string, options: LcpOptions = {}): LcpResult {
  const numTrials = options.numTrials ?? 1000;
  const alpha = options.alpha ?? 0.4;
  const gradS = options.gradS ?? 0;
  const sha256 = sha256Hex(signature);
  const seed = seedFromSignature(signature);
  const rngXi = mulberry32(seed);
  const rngFlip = mulberry32(seed ^ 0x9e3779b9);

  const xiVector: number[] = [];
  for (let i = 0; i < numTrials; i++) {
    let xi = rngXi();
    if (gradS !== 0) xi = Math.max(0, Math.min(1, xi + gradS * 0.01));
    xiVector.push(xi);
  }
  const xiMean = xiVector.reduce((a, b) => a + b, 0) / numTrials;

  const bits: number[] = [];
  for (let i = 0; i < numTrials; i++) {
    const pSuccess = 0.5 + alpha * (xiVector[i] - 0.5);
    bits.push(rngFlip() < pSuccess ? 1 : 0);
  }

  const hits = bits.reduce((a, b) => a + b, 0);
  const misses = numTrials - hits;
  const expected = numTrials * 0.5;
  const chiStat =
    expected > 0
      ? ((hits - expected) ** 2) / expected + ((misses - expected) ** 2) / expected
      : 0;
  const pValue = chiSquare1DfPValue(chiStat);

  return {
    signature,
    sha256,
    seed,
    hits,
    misses,
    hitRate: hits / numTrials,
    pValue,
    bitsHead: bits.slice(0, 20),
    alpha,
    numTrials,
    xiMean,
    significant: pValue < 0.05,
  };
}

export function formatLcpReport(result: LcpResult): string {
  const lines = [
    "=== LCP-1 Verification (honest PRNG) ===",
    `Signature:${result.signature}`,
    `SHA-256:   ${result.sha256}`,
    `Seed:      ${result.seed}`,
    `α:         ${result.alpha}`,
    `Trials:    ${result.numTrials}`,
    `Result:${result.hits} / ${result.misses} (rate ${(result.hitRate * 100).toFixed(2)}%)`,
    `ξ mean:    ${result.xiMean.toFixed(4)}`,
    `P-Value:   ${result.pValue.toExponential(6)}`,
    `Significant: ${result.significant ? "yes (p<0.05)" : "no"}`,
    `First 20: [${result.bitsHead.join(", ")}]`,
    "",
    result.significant
      ? "The deviation from 50/50 is statistically significant for this signature and α."
      : "Within the normal noise, the “magic of the coin” has not been confirmed (as expected for an honest code).",
  ];
  return lines.join("\n");
}
