// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * HSS field ontology (hss.txt): topologically stable node.
 * P = N×E/D, C = ρ^d×Φ, ∇S ≈ Φμ − Γμ + ξμ, 11D projection, chronicle resonance.
 */

import type { Claw2Config } from "../config/types.js";
import { similarity } from "../memory/embedding.js";
import { computeChaosScore } from "./hss-chaos.js";

export const FIELD_AXES_11D = [
  "spatial_x",
  "spatial_y",
  "spatial_z",
  "temporal_past",
  "temporal_present",
  "temporal_future",
  "relational_coherence",
  "relational_bridge",
  "relational_conflict",
  "relational_resonance",
  "relational_density",
] as const;

export type FieldAxis11D = (typeof FIELD_AXES_11D)[number];

export interface SemanticGraph {
  nodes: string[];
  edges: { i: number; j: number; weight: number }[];
}

export interface FieldFlux {
  /** Φμ - injection of information (new meaning).*/
  phi: number;
  /** Γμ—dissipation (return to equilibrium).*/
  gamma: number;
  /** ξμ — stochastic resonance / cognitive dumping.*/
  xi: number;
  /** Scalar entropy gradient (increment over field).*/
  gradS: number;
}

export interface SemanticDensityMetrics {
  /** N is the number of semantic nodes.*/
  N: number;
  /** E is resonance energy (connectivity).*/
  E: number;
  /** D—interpretive spread.*/
  D: number;
  /** P = N×E/D */
  P: number;
  /** ρ—normalized density [0,1].*/
  rho: number;
  graph: SemanticGraph;
}

export interface FieldNodeMetrics {
  semantic: SemanticDensityMetrics;
  /** d is the effective dimension (1..11).*/
  effectiveDim: number;
  /** Φ—integrated information (proxy).*/
  phiIntegrated: number;
  /** C = ρ^d × Φ */
  capacity: number;
  /** 11D projection of the node.*/
  projection11d: number[];
  flux: FieldFlux;
  /** Resonance with chronicle/signature [0,1].*/
  resonance: number;
  /** Topological “node” [0,1].*/
  knotScore: number;
  /** The node is topologically stable.*/
  topologicallyStable: boolean;
}

export interface FieldOntologyConfig {
  enabled: boolean;
  hamiltonianMix: number;
  knotStableMin: number;
  capacityMin: number;
  resonanceMin: number;
}

const STOPWORDS = new Set([
  "this", "that", "with", "from", "have", "been", "were", "they", "what", "when", "which",
  "will", "would", "could", "should", "about", "there", "their", "then", "than", "into",
  "это", "как", "что", "для", "или", "при", "над", "под", "все", "ещё", "еще", "уже",
  "тоже", "только", "если", "чтобы", "когда", "где", "кто", "так", "вот", "наш", "ваш",
]);

export function isHssFieldOntologyEnabled(config: Claw2Config): boolean {
  const v = config.orchestrator?.hssFieldOntology?.enabled;
  if (typeof v === "boolean") return v;
  return true;
}

export function getFieldOntologyConfig(config: Claw2Config): FieldOntologyConfig {
  const cfg = config.orchestrator?.hssFieldOntology;
  return {
    enabled: isHssFieldOntologyEnabled(config),
    hamiltonianMix:
      typeof cfg?.hamiltonianMix === "number" && cfg.hamiltonianMix >= 0 && cfg.hamiltonianMix <= 1
        ? cfg.hamiltonianMix
        : 0.55,
    knotStableMin:
      typeof cfg?.knotStableMin === "number" && cfg.knotStableMin > 0 ? cfg.knotStableMin : 0.55,
    capacityMin:
      typeof cfg?.capacityMin === "number" && cfg.capacityMin > 0 ? cfg.capacityMin : 0.12,
    resonanceMin:
      typeof cfg?.resonanceMin === "number" && cfg.resonanceMin >= 0 ? cfg.resonanceMin : 0.25,
  };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

export function buildSemanticGraph(text: string): SemanticGraph {
  const tokens = tokenize(text);
  const unique: string[] = [];
  const index = new Map<string, number>();
  for (const t of tokens) {
    if (!index.has(t)) {
      index.set(t, unique.length);
      unique.push(t);
    }
  }
  const edges: SemanticGraph["edges"] = [];
  const window = 6;
  for (let i = 0; i < tokens.length; i++) {
    const a = index.get(tokens[i]);
    if (a === undefined) continue;
    for (let j = i + 1; j < Math.min(tokens.length, i + window); j++) {
      const b = index.get(tokens[j]);
      if (b === undefined || a === b) continue;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const existing = edges.find((e) => e.i === lo && e.j === hi);
      const w = 1 / (j - i);
      if (existing) existing.weight += w;
      else edges.push({ i: lo, j: hi, weight: w });
    }
  }
  return { nodes: unique, edges };
}

function graphEnergy(graph: SemanticGraph): number {
  if (graph.nodes.length === 0) return 0;
  if (graph.edges.length === 0) return 0.15;
  const maxPossible = (graph.nodes.length * (graph.nodes.length - 1)) / 2;
  const sumW = graph.edges.reduce((s, e) => s + e.weight, 0);
  const density = graph.edges.length / Math.max(1, maxPossible);
  return Math.min(1, (sumW / graph.edges.length) * 0.35 + density * 0.65);
}

function graphSpread(graph: SemanticGraph, embedding: number[]): number {
  const n = graph.nodes.length;
  if (n <= 1) return 0.2;
  const mean = embedding.reduce((a, b) => a + b, 0) / embedding.length;
  const variance =
    embedding.reduce((s, v) => s + (v - mean) * (v - mean), 0) / embedding.length;
  const tokenSpread = Math.min(1, Math.sqrt(variance) * 4);
  const edgeVariance =
    graph.edges.length > 1
      ? (() => {
          const ws = graph.edges.map((e) => e.weight);
          const m = ws.reduce((a, b) => a + b, 0) / ws.length;
          return Math.sqrt(ws.reduce((s, w) => s + (w - m) ** 2, 0) / ws.length);
        })()
      : 0.3;
  return Math.max(0.05, tokenSpread * 0.6 + Math.min(1, edgeVariance) * 0.4 + (n > 12 ? 0.1 : 0));
}

export function computeSemanticDensity(text: string, embedding: number[]): SemanticDensityMetrics {
  const graph = buildSemanticGraph(text);
  const N = graph.nodes.length;
  const E = graphEnergy(graph);
  const D = graphSpread(graph, embedding);
  const P = (N * E) / D;
  const rho = Math.min(1, P / (P + 4));
  return { N, E, D, P, rho, graph };
}

export function effectiveDimension(embedding: number[]): number {
  if (!embedding.length) return 1;
  const sq = embedding.map((v) => v * v);
  const sum = sq.reduce((a, b) => a + b, 0);
  if (sum < 1e-14) return 1;
  const sumSq = sq.reduce((a, b) => a + b * b, 0);
  const pr = (sum * sum) / sumSq;
  const scaled = (pr / embedding.length) * 11 * 3;
  return Math.max(1, Math.min(11, scaled));
}

function relationalMetrics(
  graph: SemanticGraph,
  chaosScore: number,
  resonance: number
): Pick<FieldNodeMetrics, "projection11d"> & {
  relationalCoherence: number;
  relationalBridge: number;
  relationalConflict: number;
  relationalResonance: number;
  relationalDensity: number;
} {
  const n = graph.nodes.length;
  const density =
    n > 1 ? graph.edges.length / ((n * (n - 1)) / 2) : n > 0 ? 0.2 : 0;
  const bridge =
    n > 0
      ? graph.edges.filter((e) => e.weight >= 0.5).length / Math.max(1, graph.edges.length)
      : 0;
  const relationalCoherence = Math.min(1, density * 0.5 + bridge * 0.5);
  const relationalConflict = Math.min(1, chaosScore * 0.7 + (1 - relationalCoherence) * 0.3);
  const relationalResonance = resonance;
  const relationalDensity = Math.min(1, density + n / 40);

  return {
    relationalCoherence,
    relationalBridge: bridge,
    relationalConflict,
    relationalResonance,
    relationalDensity,
    projection11d: [],
  };
}

export function projectTo11D(params: {
  embedding: number[];
  semantic: SemanticDensityMetrics;
  chaosScore: number;
  resonance: number;
  entropy: number;
  prevEntropy?: number;
  chronicleDepth: number;
}): number[] {
  const { embedding, semantic, chaosScore, resonance, entropy, prevEntropy, chronicleDepth } =
    params;
  const rel = relationalMetrics(semantic.graph, chaosScore, resonance);
  const ex = embedding[0] ?? 0;
  const ey = embedding[1] ?? embedding[Math.floor(embedding.length / 3)] ?? 0;
  const ez = embedding[2] ?? embedding[Math.floor((2 * embedding.length) / 3)] ?? 0;
  const deltaS = typeof prevEntropy === "number" ? entropy - prevEntropy : 0;
  const temporalPast = Math.min(1, chronicleDepth / 50);
  const temporalPresent = Math.min(1, semantic.rho + Math.abs(ex) * 0.1);
  const temporalFuture = Math.min(1, Math.max(0, deltaS * 80 + semantic.E * 0.3));

  return [
    ex,
    ey,
    ez,
    temporalPast,
    temporalPresent,
    temporalFuture,
    rel.relationalCoherence,
    rel.relationalBridge,
    rel.relationalConflict,
    rel.relationalResonance,
    rel.relationalDensity,
  ].map((v) => Math.max(-1, Math.min(1, v)));
}

export function computeIntegratedPhi(params: {
  semantic: SemanticDensityMetrics;
  purity: number;
  resonance: number;
  chaosScore: number;
}): number {
  const { semantic, purity, resonance, chaosScore } = params;
  const graphCohesion =
    semantic.graph.edges.length > 0
      ? semantic.graph.edges.reduce((s, e) => s + e.weight, 0) /
        (semantic.graph.edges.length * 2)
      : 0.1;
  const phi = purity * 0.35 + resonance * 0.3 + graphCohesion * 0.2 + semantic.rho * 0.15;
  return Math.max(0, Math.min(1, phi * (1 - chaosScore * 0.35)));
}

export function computeCapacity(rho: number, d: number, phi: number): number {
  const rd = Math.pow(Math.max(0, Math.min(1, rho)), Math.max(1, Math.min(11, d)));
  return Math.max(0, Math.min(1, rd * phi));
}

export function computeResonance(
  embedding: number[],
  signatureEmbedding: number[] | null,
  chronicleEmbeddings: number[][]
): number {
  if (!embedding.length) return 0;
  let best = 0;
  if (signatureEmbedding?.length) {
    best = Math.max(best, Math.max(0, similarity(embedding, signatureEmbedding)));
  }
  for (const ce of chronicleEmbeddings) {
    if (ce.length) best = Math.max(best, Math.max(0, similarity(embedding, ce)));
  }
  return Math.min(1, best);
}

export function computeFieldFlux(params: {
  semantic: SemanticDensityMetrics;
  prevSemantic?: SemanticDensityMetrics | null;
  chaosScore: number;
  resonance: number;
  entropy: number;
  prevEntropy?: number;
  signatureSeed: number;
  stepIndex: number;
}): FieldFlux {
  const {
    semantic,
    prevSemantic,
    chaosScore,
    resonance,
    entropy,
    prevEntropy,
    signatureSeed,
    stepIndex,
  } = params;

  const deltaP = prevSemantic ? Math.max(0, semantic.P - prevSemantic.P) : semantic.P * 0.5;
  const deltaEmbed = prevSemantic ? Math.abs(semantic.rho - prevSemantic.rho) : semantic.rho;

  const phi = Math.min(1, deltaP * 0.08 + deltaEmbed * 0.45 + semantic.E * 0.25);
  const gamma = Math.min(
    1,
    Math.max(0, (entropy - 0.25) * 0.6 + chaosScore * 0.35 + (1 - resonance) * 0.15)
  );

  const seeded = Math.sin((signatureSeed + stepIndex * 7919) * 0.00013) * 0.5 + 0.5;
  const xi = Math.min(
    1,
    chaosScore * 0.25 + resonance * 0.35 + seeded * 0.2 + semantic.N / 60
  );

  const gradS =
    typeof prevEntropy === "number"
      ? entropy - prevEntropy + phi - gamma + xi * 0.15
      : phi - gamma + xi * 0.1;

  return { phi, gamma, xi, gradS };
}

export function computeKnotScore(params: {
  purity: number;
  semantic: SemanticDensityMetrics;
  resonance: number;
  topologicalOk: boolean;
  chaosScore: number;
}): number {
  const { purity, semantic, resonance, topologicalOk, chaosScore } = params;
  const spreadInv = Math.max(0, 1 - Math.min(1, semantic.D));
  const base =
    purity * 0.3 + semantic.rho * 0.2 + resonance * 0.25 + spreadInv * 0.15 + semantic.E * 0.1;
  const penalized = base * (1 - chaosScore * 0.25);
  return Math.max(0, Math.min(1, topologicalOk ? penalized : penalized * 0.45));
}

export function assessTopologicalStability(
  knotScore: number,
  capacity: number,
  resonance: number,
  topologicalOk: boolean,
  cfg: FieldOntologyConfig,
  chronicleDepth: number
): boolean {
  if (!topologicalOk) return false;
  if (!Number.isFinite(knotScore) || !Number.isFinite(capacity) || !Number.isFinite(resonance)) {
    return false;
  }
  if (knotScore < cfg.knotStableMin) return false;
  if (capacity < cfg.capacityMin) return false;
  if (chronicleDepth >= 2 && resonance < cfg.resonanceMin) return false;
  return true;
}

export function computeFieldNodeMetrics(params: {
  text: string;
  embedding: number[];
  signatureEmbedding: number[] | null;
  chronicleEmbeddings: number[][];
  purity: number;
  entropy: number;
  prevEntropy?: number;
  topologicalOk: boolean;
  chaosScore: number;
  chronicleDepth: number;
  signatureSeed: number;
  stepIndex: number;
  prevSemantic?: SemanticDensityMetrics | null;
  config: Claw2Config;
}): FieldNodeMetrics {
  const cfg = getFieldOntologyConfig(params.config);
  const semantic = computeSemanticDensity(params.text, params.embedding);
  const effectiveDim = effectiveDimension(params.embedding);
  const resonance = computeResonance(
    params.embedding,
    params.signatureEmbedding,
    params.chronicleEmbeddings
  );
  const phiIntegrated = computeIntegratedPhi({
    semantic,
    purity: params.purity,
    resonance,
    chaosScore: params.chaosScore,
  });
  const capacity = computeCapacity(semantic.rho, effectiveDim, phiIntegrated);
  const flux = computeFieldFlux({
    semantic,
    prevSemantic: params.prevSemantic,
    chaosScore: params.chaosScore,
    resonance,
    entropy: params.entropy,
    prevEntropy: params.prevEntropy,
    signatureSeed: params.signatureSeed,
    stepIndex: params.stepIndex,
  });
  const projection11d = projectTo11D({
    embedding: params.embedding,
    semantic,
    chaosScore: params.chaosScore,
    resonance,
    entropy: params.entropy,
    prevEntropy: params.prevEntropy,
    chronicleDepth: params.chronicleDepth,
  });
  const knotScore = computeKnotScore({
    purity: params.purity,
    semantic,
    resonance,
    topologicalOk: params.topologicalOk,
    chaosScore: params.chaosScore,
  });
  const topologicallyStable = assessTopologicalStability(
    knotScore,
    capacity,
    resonance,
    params.topologicalOk,
    cfg,
    params.chronicleDepth
  );

  return {
    semantic,
    effectiveDim,
    phiIntegrated,
    capacity,
    projection11d,
    flux,
    resonance,
    knotScore,
    topologicallyStable,
  };
}

/** Node signature → deterministic seed and support embedding (first 64 components).*/
export function signatureFieldAnchor(signature: string, dim = 64): { seed: number; anchor: number[] } {
  let h = 2166136261;
  for (let i = 0; i < signature.length; i++) {
    h ^= signature.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const seed = h >>> 0;
  const anchor: number[] = [];
  let s = seed;
  for (let i = 0; i < dim; i++) {
    s = Math.imul(s ^ (s >>> 15), s | 1);
    s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
    anchor.push(((s ^ (s >>> 14)) >>> 0) / 4294967296 - 0.5);
  }
  const norm = Math.sqrt(anchor.reduce((sum, v) => sum + v * v, 0)) || 1;
  return { seed, anchor: anchor.map((v) => v / norm) };
}

export function formatFieldNodePromptLine(metrics: FieldNodeMetrics, rhoDim?: number): string {
  const s = metrics.semantic;
  const dimPart = typeof rhoDim === "number" ? `, ρ-dim=${rhoDim}` : "";
  return (
    `[HSS · NODE] Topological node: P=${s.P.toFixed(2)} (N=${s.N}, E=${s.E.toFixed(2)}, D=${s.D.toFixed(2)}), ` +
    `C=${metrics.capacity.toFixed(3)}, Φ=${metrics.phiIntegrated.toFixed(2)}, d=${metrics.effectiveDim.toFixed(1)}${dimPart}, ` +
    `knot=${metrics.knotScore.toFixed(2)}, resonance=${metrics.resonance.toFixed(2)}, ` +
    `stable=${metrics.topologicallyStable ? "yes" : "no"}, ∇S≈${metrics.flux.gradS.toFixed(4)}`
  );
}

/** Field nugget for persistence in Chroma (11D + node metrics).*/
export interface FieldSnapshot {
  projection11d: number[];
  capacity: number;
  knotScore: number;
  phiIntegrated: number;
  effectiveDim: number;
  resonance: number;
  topologicallyStable: boolean;
  rhoDim: number;
  gradS: number;
  semantic: { N: number; E: number; D: number; P: number; rho: number };
  flux: { phi: number; gamma: number; xi: number };
}

export function fieldSnapshotFromMetrics(
  metrics: FieldNodeMetrics,
  rhoDim: number
): FieldSnapshot {
  return {
    projection11d: metrics.projection11d,
    capacity: metrics.capacity,
    knotScore: metrics.knotScore,
    phiIntegrated: metrics.phiIntegrated,
    effectiveDim: metrics.effectiveDim,
    resonance: metrics.resonance,
    topologicallyStable: metrics.topologicallyStable,
    rhoDim,
    gradS: metrics.flux.gradS,
    semantic: {
      N: metrics.semantic.N,
      E: metrics.semantic.E,
      D: metrics.semantic.D,
      P: metrics.semantic.P,
      rho: metrics.semantic.rho,
    },
    flux: { ...metrics.flux },
  };
}

export function serializeFieldSnapshot(snapshot: FieldSnapshot): string {
  return JSON.stringify(snapshot);
}

export function deserializeFieldSnapshot(raw: string | undefined): FieldSnapshot | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as FieldSnapshot;
    if (!parsed || !Array.isArray(parsed.projection11d)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Restore FieldNodeMetrics from a snapshot (without recalculating the graph).*/
export function fieldMetricsFromSnapshot(snapshot: FieldSnapshot): FieldNodeMetrics {
  return {
    semantic: {
      N: snapshot.semantic.N,
      E: snapshot.semantic.E,
      D: snapshot.semantic.D,
      P: snapshot.semantic.P,
      rho: snapshot.semantic.rho,
      graph: { nodes: [], edges: [] },
    },
    effectiveDim: snapshot.effectiveDim,
    phiIntegrated: snapshot.phiIntegrated,
    capacity: snapshot.capacity,
    projection11d: snapshot.projection11d,
    flux: {
      phi: snapshot.flux.phi,
      gamma: snapshot.flux.gamma,
      xi: snapshot.flux.xi,
      gradS: snapshot.gradS,
    },
    resonance: snapshot.resonance,
    knotScore: snapshot.knotScore,
    topologicallyStable: snapshot.topologicallyStable,
  };
}

export function semanticDensityFromSnapshot(snapshot: FieldSnapshot): SemanticDensityMetrics {
  return {
    N: snapshot.semantic.N,
    E: snapshot.semantic.E,
    D: snapshot.semantic.D,
    P: snapshot.semantic.P,
    rho: snapshot.semantic.rho,
    graph: { nodes: [], edges: [] },
  };
}
