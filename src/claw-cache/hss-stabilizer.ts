/**
 * Wrapper over HSS (hss.js) for personality stabilization and orchestration.
 * Chronicle is persisted in Chroma (when configured); semantic-search entropy stays within bounds.
 */

import { resolve } from "node:path";
import type OpenAI from "openai";
import type { Claw2Config } from "../config/types.js";
import { loadHssModule, resolveHssCjsPath } from "./hss-path.js";
import {
  loadChronicleEntries,
  persistChronicleEntry,
  isChronicleChromaConfigured,
  getChronicleMaxContextChars,
  type ChronicleEntryPayload,
} from "./chronicle-chroma.js";
import {
  getDefaultAutoChronicleImportance,
  getDefaultModelChronicleImportance,
  clampImportance,
} from "./chronicle-importance.js";
import { encodeHssContext, HSS_CONTEXT_EMBEDDING_DIM } from "./hss-context-encoder.js";
import { getEmbedding } from "../memory/embedding.js";
import { consumeActivationVectorSeed } from "./activation-vector-seed.js";
import { ACTIVATION_VECTOR_DIM } from "./activation-vector.js";
import { BoundedIdleStore } from "./bounded-idle-store.js";
import { hssContextFields, hssLog } from "./hss-log.js";
import { chaosScoreToDeltaBoost, computeChaosScore } from "./hss-chaos.js";
import {
  computeFieldNodeMetrics,
  fieldMetricsFromSnapshot,
  fieldSnapshotFromMetrics,
  getFieldOntologyConfig,
  isHssFieldOntologyEnabled,
  semanticDensityFromSnapshot,
  signatureFieldAnchor,
  type FieldNodeMetrics,
  type SemanticDensityMetrics,
} from "./hss-field-ontology.js";
import {
  resolveTargetRhoDim,
  RHO_DIM_BASE,
  rhoDimFromMatrix,
} from "./hss-rho-dimension.js";

type HssModule = {
  IntentionModule: new (signature: string, size?: number) => unknown;
  TopologicalNode: new (dim: number, intention: unknown, chronicle?: unknown, contextEncoder?: unknown) => unknown;
  Chronicle: new (maxSize?: number) => { entries: unknown[]; add: (e: unknown) => void };
  ChronicleEntry: new (opts: ChronicleEntryPayload) => unknown;
  ContextEncoder: new (dim?: number) => unknown;
  /** ≥ rhoDimFull² so H has no undefined→NaN at dim=11 */
  INTENTION_XI_DEFAULT_SIZE?: number;
};

let hssModule: HssModule | null = null;
let hssModuleLoadLogged = false;

function getHss(config?: Claw2Config): HssModule | null {
  if (hssModule) return hssModule;
  const loaded = loadHssModule<HssModule>();
  if (loaded) {
    hssModule = loaded.mod;
    if (!hssModuleLoadLogged) {
      hssModuleLoadLogged = true;
      hssLog("module_loaded", { path: loaded.path }, config);
    }
    return hssModule;
  }
  if (!hssModuleLoadLogged) {
    hssModuleLoadLogged = true;
    hssLog(
      "module_unavailable",
      {
        path: resolveHssCjsPath() ?? resolve(process.cwd(), "hss.cjs"),
        error: "Cannot find or load hss.cjs",
      },
      config
    );
  }
  return hssModule;
}

const COHERENCE_SETTLED_MIN = 0.8;

/**
 * Master switch for the dialog-stability layer: `orchestrator.hss.enabled`
 * (default true). False disables session-state evolution, chronicle recall
 * and the response-mode addendum — the ablation/opt-out path.
 */
export function isHssEnabled(config?: Claw2Config): boolean {
  return config?.orchestrator?.hss?.enabled !== false;
}

export const DEFAULT_HSS_ENTROPY_DELTA_STABILIZE_MIN = 0.0015;
export const DEFAULT_HSS_CONTEXT_CHUNK_SIZE = 400;
export const DEFAULT_HSS_CONTEXT_CHUNK_MIN_LEN = 600;
type NodeStoreEntry = {
  intention: unknown;
  node: unknown;
  restoredFromChronicle?: boolean;
  prevSemantic?: SemanticDensityMetrics | null;
  fieldMetrics?: FieldNodeMetrics | null;
  signatureSeed?: number;
  signatureAnchor?: number[];
  rhoDim?: number;
};

export const HSS_NODE_STORE_MAX_ENTRIES = 64;
export const HSS_NODE_STORE_IDLE_TTL_MS = 2 * 60 * 60 * 1000;

const nodeStore = new BoundedIdleStore<string, NodeStoreEntry>({
  maxEntries: HSS_NODE_STORE_MAX_ENTRIES,
  idleTtlMs: HSS_NODE_STORE_IDLE_TTL_MS,
});

/** Releases only process-local HSS nodes; persisted chronicle entries remain intact. */
export function releaseHssSession(sessionId: string): number {
  const prefix = `${sessionId}:`;
  return nodeStore.deleteWhere((key) => key.startsWith(prefix));
}

/** Test visibility without exposing node contents. */
export function getHssNodeStoreSizeForTests(): number {
  return nodeStore.size;
}

export interface HssState {
  coherence: number;
  status: "STABLE" | "FRAGMENTED";
  settled: boolean;
  entropy: number;
  entropyDelta: number;
  maxChunkEntropyDelta?: number;
  sumPositiveChunkDelta?: number;
  chunkCount?: number;
  chaosScore?: number;
  /** ΔS + chaos heuristics are the basis for stabilize.*/
  effectiveDelta?: number;
  restoredFromChronicle?: boolean;
  /** First measurement without chronicle: do not turn on stabilizer.*/
  calibrationTurn?: boolean;
  /** Field ontology (hss.txt).*/
  field?: FieldNodeMetrics;
  /** Current dim of matrix ρ.*/
  rhoDim?: number;
}

export function getHssEntropyDeltaStabilizeMin(config: Claw2Config): number {
  const delta = config.orchestrator?.hssEntropyDeltaStabilizeMin;
  if (typeof delta === "number" && delta > 0) return delta;
  const legacy = config.orchestrator?.hssEntropyStabilizeMin;
  if (typeof legacy === "number" && legacy > 0) return legacy;
  return DEFAULT_HSS_ENTROPY_DELTA_STABILIZE_MIN;
}

/** @deprecated Use getHssEntropyDeltaStabilizeMin*/
export function getHssEntropyStabilizeMin(config: Claw2Config): number {
  return getHssEntropyDeltaStabilizeMin(config);
}

export function getHssContextChunkSize(config: Claw2Config): number {
  const v = config.orchestrator?.hssContextChunkSize;
  return typeof v === "number" && v >= 100 ? v : DEFAULT_HSS_CONTEXT_CHUNK_SIZE;
}

export function getHssContextChunkMinLen(config: Claw2Config): number {
  const v = config.orchestrator?.hssContextChunkMinLen;
  return typeof v === "number" && v >= 200 ? v : DEFAULT_HSS_CONTEXT_CHUNK_MIN_LEN;
}

export function resolveHssPromptMode(state: HssState, config: Claw2Config): "stable" | "stabilize" {
  if (state.calibrationTurn) return "stable";
  const threshold = getHssEntropyDeltaStabilizeMin(config);
  const delta = state.effectiveDelta ?? state.maxChunkEntropyDelta ?? state.entropyDelta;
  return delta >= threshold ? "stabilize" : "stable";
}

function computeEffectiveDelta(
  entropyDelta: number,
  maxChunkEntropyDelta: number,
  sumPositiveChunkDelta: number,
  chunkCount: number,
  chaosScore: number
): number {
  const base =
    chunkCount > 1
      ? Math.max(maxChunkEntropyDelta, sumPositiveChunkDelta * 0.4)
      : Math.max(entropyDelta, maxChunkEntropyDelta);
  return base + chaosScoreToDeltaBoost(chaosScore);
}

export function splitHssContextChunks(context: string, chunkSize: number): string[] {
  if (!context || context.length <= chunkSize) return [context ?? ""];
  const chunks: string[] = [];
  for (let i = 0; i < context.length; i += chunkSize) {
    chunks.push(context.slice(i, i + chunkSize));
  }
  return chunks;
}

function measureNodeState(node: {
  check_topological_invariant: () => { status: string; coherence?: number; trace?: number };
  measure_coherence?: () => number;
  chronicle?: { entries?: unknown[] };
}): HssState {
  const inv = node.check_topological_invariant();
  const coherence = node.measure_coherence ? node.measure_coherence() : (inv as { trace?: number }).trace ?? 0;
  const status = (inv.status === "STABLE" ? "STABLE" : "FRAGMENTED") as "STABLE" | "FRAGMENTED";
  const entries = node.chronicle?.entries;
  const last =
    Array.isArray(entries) && entries.length > 0
      ? (entries[entries.length - 1] as { entropy?: number })
      : null;
  const prev =
    Array.isArray(entries) && entries.length > 1
      ? (entries[entries.length - 2] as { entropy?: number })
      : null;
  const entropy = typeof last?.entropy === "number" ? last.entropy : 0;
  const prevEntropy = typeof prev?.entropy === "number" ? prev.entropy : entropy;
  return {
    coherence: typeof coherence === "number" ? coherence : 0,
    status,
    settled: status === "STABLE" && (typeof coherence === "number" ? coherence > COHERENCE_SETTLED_MIN : false),
    entropy,
    entropyDelta: entropy - prevEntropy,
  };
}

function entropyBeforeEvolve(node: { chronicle?: { entries?: unknown[] } }): number {
  const entries = node.chronicle?.entries;
  if (!Array.isArray(entries) || entries.length === 0) return 0;
  const last = entries[entries.length - 1] as { entropy?: number };
  return typeof last.entropy === "number" ? last.entropy : 0;
}

type EvolveNode = {
  evolve: (opts?: {
    dt?: number;
    H?: unknown;
    noise_strength?: number;
    lindblad_strength?: number;
    xi_mu_mode?: string;
    context?: string;
    useInnerXi?: boolean;
    saveToChronicle?: boolean;
    chronicleImportance?: number;
    contextEmbedding?: number[];
    fieldFlux?: { phi: number; gamma: number; xi: number };
    hamiltonianMix?: number;
  }) => { S: number; coh: number; expmFallback?: string };
  check_topological_invariant: () => { status: string; coherence?: number; trace?: number; ok?: boolean };
  measure_coherence?: () => number;
  chronicle?: { entries?: unknown[] };
};

function getNodeRhoDim(node: unknown): number {
  const n = node as { dim?: number; rho?: { re?: number[][] } };
  if (typeof n.dim === "number" && n.dim > 0) return n.dim;
  return rhoDimFromMatrix(n.rho);
}

function maybeGrowRhoDimension(
  node: unknown,
  fieldMetrics: FieldNodeMetrics | undefined,
  config: Claw2Config
): number {
  if (!fieldMetrics || !isHssFieldOntologyEnabled(config)) return getNodeRhoDim(node);
  const current = getNodeRhoDim(node);
  const target = resolveTargetRhoDim(
    fieldMetrics.capacity,
    fieldMetrics.effectiveDim,
    current,
    config
  );
  if (target <= current) return current;
  const resizable = node as { resizeDimension?: (d: number) => number };
  if (typeof resizable.resizeDimension === "function") {
    const newDim = resizable.resizeDimension(target);
    hssLog(
      "rho_dim_grown",
      {
        from: current,
        to: newDim,
        capacity: fieldMetrics.capacity,
        effectiveDim: fieldMetrics.effectiveDim,
      },
      config
    );
    return newDim;
  }
  return current;
}

function runChunkedEvolve(
  node: EvolveNode,
  context: string,
  config: Claw2Config,
  chronicleImportance: number,
  evolveOpts?: {
    contextEmbedding?: number[];
    fieldFlux?: { phi: number; gamma: number; xi: number };
    hamiltonianMix?: number;
  }
): {
  evolveResult: { S: number; coh: number; expmFallback?: string };
  entropyDelta: number;
  maxChunkEntropyDelta: number;
  sumPositiveChunkDelta: number;
  chunkCount: number;
} {
  const chunkMinLen = getHssContextChunkMinLen(config);
  const chunkSize = getHssContextChunkSize(config);
  const useChunks = context.length > chunkMinLen;
  const chunks = useChunks ? splitHssContextChunks(context, chunkSize) : [context];

  const baselineEntropy = entropyBeforeEvolve(node);
  let stepEntropy = baselineEntropy;
  let maxChunkEntropyDelta = 0;
  let sumPositiveChunkDelta = 0;
  let evolveResult: { S: number; coh: number; expmFallback?: string } = { S: stepEntropy, coh: 1 };

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const chunk = chunks[i];
    try {
      evolveResult = node.evolve({
        dt: 0.3,
        H: null,
        noise_strength: 0.0005,
        lindblad_strength: 0.25,
        xi_mu_mode: "coherence_preserving",
        context: chunk,
        useInnerXi: true,
        saveToChronicle: isLast,
        chronicleImportance: isLast ? chronicleImportance : undefined,
        contextEmbedding: evolveOpts?.contextEmbedding,
        fieldFlux: evolveOpts?.fieldFlux,
        hamiltonianMix: evolveOpts?.hamiltonianMix,
      });
      if (evolveResult.expmFallback) {
        hssLog(
          "expm_fallback",
          {
            method: evolveResult.expmFallback,
            chunkIndex: i,
            chunkCount: chunks.length,
            rhoDim: getNodeRhoDim(node),
          },
          config
        );
      }
    } catch (err) {
      hssLog(
        "evolve_skipped",
        {
          reason: "evolve_throw",
          chunkIndex: i,
          chunkCount: chunks.length,
          rhoDim: getNodeRhoDim(node),
          error: err instanceof Error ? err.message : String(err),
        },
        config
      );
      continue;
    }
    const chunkDelta = evolveResult.S - stepEntropy;
    if (chunkDelta > 0) sumPositiveChunkDelta += chunkDelta;
    if (chunkDelta > maxChunkEntropyDelta) maxChunkEntropyDelta = chunkDelta;
    stepEntropy = evolveResult.S;
  }

  return {
    evolveResult,
    entropyDelta: useChunks ? maxChunkEntropyDelta : evolveResult.S - baselineEntropy,
    maxChunkEntropyDelta,
    sumPositiveChunkDelta,
    chunkCount: chunks.length,
  };
}

/**
 * The current state of the node without the evolve step (for empty model responses / tool-only moves).
 */
export async function peekHssState(
  sessionId: string,
  cacheId: string,
  config?: Claw2Config
): Promise<HssState | null> {
  const key = `${sessionId}:${cacheId}`;
  const existing = nodeStore.get(key);
  if (!existing) return null;
  const node = existing.node as Parameters<typeof measureNodeState>[0];
  const base = measureNodeState(node);
  return { ...base, field: existing.fieldMetrics ?? undefined, rhoDim: existing.rhoDim };
}

/**
 * Returns or creates an HSS node for the session. When enabled, Chroma loads the chronicle from the database.
 */
async function getOrCreateNode(
  sessionId: string,
  cacheId: string,
  config: Claw2Config
): Promise<NodeStoreEntry | null> {
  const key = `${sessionId}:${cacheId}`;
  const existing = nodeStore.get(key);
  if (existing) {
    hssLog("node_cache_hit", { sessionId, cacheId, nodeKey: key }, config);
    return { ...existing, restoredFromChronicle: existing.restoredFromChronicle ?? false };
  }

  const hss = getHss(config);
  if (!hss?.IntentionModule || !hss?.TopologicalNode || !hss.Chronicle || !hss.ChronicleEntry || !hss.ContextEncoder) {
    hssLog("evolve_skipped", { sessionId, cacheId, reason: "hss_module_incomplete" }, config);
    return null;
  }

  const { Chronicle, ChronicleEntry, ContextEncoder, IntentionModule, TopologicalNode } = hss;
  const signature = `${sessionId}:${cacheId}`;
  const { seed: signatureSeed, anchor: signatureAnchor } = signatureFieldAnchor(signature);
  const intention = new IntentionModule(signature, hss.INTENTION_XI_DEFAULT_SIZE ?? 128);
  const chronicle = new Chronicle(1000);
  const contextEncoder = new ContextEncoder(64);
  let loaded: ChronicleEntryPayload[] = [];
  let restoredFromChronicle = false;
  let restoredFieldMetrics: FieldNodeMetrics | null = null;
  let restoredPrevSemantic: SemanticDensityMetrics | null = null;
  let initialRhoDim = RHO_DIM_BASE;
  let seededFromActivationVector = false;

  if (isChronicleChromaConfigured(config)) {
    loaded = await loadChronicleEntries(config, sessionId, cacheId, 1000);
    hssLog(
      "chronicle_loaded",
      {
        sessionId,
        cacheId,
        entriesLoaded: loaded.length,
        chronicleConfigured: true,
      },
      config
    );
    for (const p of loaded) {
      chronicle.add(
        new ChronicleEntry({
          timestamp: p.timestamp,
          entropy: p.entropy,
          coherence: p.coherence,
          context: p.context,
          context_embedding: p.context_embedding,
          xi_used: p.xi_used,
          rho: p.rho ?? null,
          importance: p.importance ?? 0.5,
        })
      );
    }
  }

  // Chain from activation/vector.npy - only if the chronicle is still empty (new node).
  if (loaded.length === 0) {
    const seed = consumeActivationVectorSeed(sessionId, cacheId);
    if (seed?.rows.length) {
      const now = Date.now() / 1000;
      const n = seed.rows.length;
      for (let i = 0; i < n; i++) {
        const emb = seed.rows[i]!;
        if (emb.length !== ACTIVATION_VECTOR_DIM && emb.length !== 64) continue;
        const padded =
          emb.length === ACTIVATION_VECTOR_DIM
            ? emb
            : emb.length > ACTIVATION_VECTOR_DIM
              ? emb.slice(0, ACTIVATION_VECTOR_DIM)
              : [...emb, ...new Array(ACTIVATION_VECTOR_DIM - emb.length).fill(0)];
        chronicle.add(
          new ChronicleEntry({
            timestamp: now - (n - i) * 0.01,
            entropy: 0.45,
            coherence: 0.85,
            context: (seed.contexts[i] ?? `[activation:${i}]`).slice(0, 500),
            context_embedding: padded,
            xi_used: null,
            rho: null,
            importance: 0.35,
          })
        );
      }
      seededFromActivationVector = true;
      hssLog(
        "activation_vector_seeded",
        {
          sessionId,
          cacheId,
          turns: n,
          dim: seed.dim,
          encoder: seed.encoder,
        },
        config
      );
    }
  }

  const lastWithField = [...loaded].reverse().find((p) => p.field_snapshot);
  const lastWithRho = [...loaded].reverse().find((p) => p.rho);
  if (lastWithField?.field_snapshot) {
    restoredFieldMetrics = fieldMetricsFromSnapshot(lastWithField.field_snapshot);
    restoredPrevSemantic = semanticDensityFromSnapshot(lastWithField.field_snapshot);
    initialRhoDim = lastWithField.field_snapshot.rhoDim || lastWithField.rho_dim || RHO_DIM_BASE;
  } else if (lastWithRho?.rho_dim) {
    initialRhoDim = lastWithRho.rho_dim;
  } else if (lastWithRho?.rho) {
    initialRhoDim = rhoDimFromMatrix(lastWithRho.rho);
  }

  const node = new TopologicalNode(initialRhoDim, intention, chronicle, contextEncoder);

  if (lastWithRho?.rho) {
    const restorable = node as { restoreFromEntry: (e: { rho: unknown }) => void };
    restorable.restoreFromEntry({ rho: lastWithRho.rho });
    restoredFromChronicle = true;
    hssLog(
      "restored_from_chronicle",
      {
        sessionId,
        cacheId,
        timestamp: lastWithRho.timestamp,
        entropy: lastWithRho.entropy,
        coherence: lastWithRho.coherence,
        rhoDim: getNodeRhoDim(node),
        fieldSnapshot: !!lastWithField?.field_snapshot,
      },
      config
    );
  } else {
    (node as unknown as { rho: unknown }).rho = (
      intention as { get_xi_matrix_coherence_preserving: (dim: number, scale: number) => unknown }
    ).get_xi_matrix_coherence_preserving(initialRhoDim, 1);
  }

  const entry: NodeStoreEntry = {
    intention,
    node,
    restoredFromChronicle,
    prevSemantic: restoredPrevSemantic,
    fieldMetrics: restoredFieldMetrics,
    signatureSeed,
    signatureAnchor,
    rhoDim: getNodeRhoDim(node),
  };
  nodeStore.set(key, entry);
  hssLog(
    "node_created",
    {
      sessionId,
      cacheId,
      nodeKey: key,
      chronicleConfigured: isChronicleChromaConfigured(config),
      chronicleEntriesInMemory: (chronicle as { entries?: unknown[] }).entries?.length ?? 0,
      restoredFromChronicle,
      seededFromActivationVector,
    },
    config
  );
  return entry;
}

function lastChronicleEntry(node: unknown): ChronicleEntryPayload | null {
  const n = node as { chronicle?: { entries?: unknown[] } };
  const entries = n?.chronicle?.entries;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const e = entries[entries.length - 1] as {
    timestamp?: number;
    entropy?: number;
    coherence?: number;
    context?: string;
    context_embedding?: number[];
    xi_used?: { re: number[][]; im: number[][] } | null;
    rho?: { re: number[][]; im: number[][] } | null;
    importance?: number;
  };
  if (!e || e.timestamp == null) return null;
  return {
    timestamp: e.timestamp,
    entropy: e.entropy ?? 0,
    coherence: e.coherence ?? 0,
    context: e.context ?? "",
    context_embedding: Array.isArray(e.context_embedding) ? e.context_embedding : [],
    xi_used: e.xi_used ?? null,
    rho: e.rho ?? null,
    importance: Math.max(0, Math.min(1, e.importance ?? 0.5)),
  };
}

function chronicleEmbeddingsFromNode(node: unknown): number[][] {
  const entries = (node as { chronicle?: { entries?: unknown[] } }).chronicle?.entries;
  if (!Array.isArray(entries)) return [];
  const out: number[][] = [];
  for (const e of entries.slice(-12)) {
    const emb = (e as { context_embedding?: number[] }).context_embedding;
    if (Array.isArray(emb) && emb.length) out.push(emb);
  }
  return out;
}

/**
 * Performs one HSS evolution step and returns coherence and status.
 * Long context is divided into chunks; stabilize is based on max ΔS across chunks.
 */
export async function evolveHssAndGetState(
  sessionId: string,
  cacheId: string,
  context?: string,
  config?: Claw2Config,
  options?: { llmClient?: OpenAI }
): Promise<HssState | null> {
  const conf = config ?? ({} as Claw2Config);
  if (!isHssEnabled(conf)) return null;
  const entry = await getOrCreateNode(sessionId, cacheId, conf);
  if (!entry) return null;

  const node = entry.node as EvolveNode;
  const text = context ?? "";
  const chronicleSizeBefore = node.chronicle?.entries?.length ?? 0;
  const autoImportance = getDefaultAutoChronicleImportance(conf);
  const fieldEnabled = isHssFieldOntologyEnabled(conf);
  const fieldCfg = getFieldOntologyConfig(conf);

  let contextEmbedding: number[] | undefined;
  if (fieldEnabled && text.trim() && options?.llmClient) {
    try {
      contextEmbedding = await getEmbedding(options.llmClient, conf, text);
    } catch (err) {
      hssLog(
        "evolve_skipped",
        {
          sessionId,
          cacheId,
          reason: "field_embedding_failed",
          error: err instanceof Error ? err.message : String(err),
        },
        conf
      );
    }
  }

  const baselineEntropy = entropyBeforeEvolve(node);
  const invBefore = node.check_topological_invariant();
  const purityBefore =
    typeof node.measure_coherence === "function"
      ? node.measure_coherence()
      : (invBefore.trace ?? 1);
  const chaosScorePre = computeChaosScore(text);

  let fieldMetrics: FieldNodeMetrics | undefined;
  let evolveOpts: {
    contextEmbedding?: number[];
    fieldFlux?: { phi: number; gamma: number; xi: number };
    hamiltonianMix?: number;
  } | undefined;

  if (fieldEnabled && contextEmbedding?.length) {
    fieldMetrics = computeFieldNodeMetrics({
      text,
      embedding: contextEmbedding,
      signatureEmbedding: entry.signatureAnchor ?? null,
      chronicleEmbeddings: chronicleEmbeddingsFromNode(node),
      purity: typeof purityBefore === "number" ? purityBefore : 1,
      entropy: baselineEntropy,
      prevEntropy: baselineEntropy,
      topologicalOk: invBefore.ok !== false,
      chaosScore: chaosScorePre,
      chronicleDepth: chronicleSizeBefore,
      signatureSeed: entry.signatureSeed ?? 0,
      stepIndex: chronicleSizeBefore,
      prevSemantic: entry.prevSemantic ?? null,
      config: conf,
    });
    maybeGrowRhoDimension(node, fieldMetrics, conf);
    evolveOpts = {
      contextEmbedding,
      fieldFlux: {
        phi: fieldMetrics.flux.phi,
        gamma: fieldMetrics.flux.gamma,
        xi: fieldMetrics.flux.xi,
      },
      hamiltonianMix: fieldCfg.hamiltonianMix,
    };
  }

  const { evolveResult, entropyDelta, maxChunkEntropyDelta, sumPositiveChunkDelta, chunkCount } =
    runChunkedEvolve(node, text, conf, autoImportance, evolveOpts);

  const chaosScore = chaosScorePre;
  const calibrationTurn = chronicleSizeBefore === 0 && !entry.restoredFromChronicle;
  const effectiveDelta = calibrationTurn
    ? 0
    : computeEffectiveDelta(entropyDelta, maxChunkEntropyDelta, sumPositiveChunkDelta, chunkCount, chaosScore);

  const chronicleSizeAfter = node.chronicle?.entries?.length ?? chronicleSizeBefore;
  const last = lastChronicleEntry(node);
  let persisted = false;

  if (isChronicleChromaConfigured(conf)) {
    if (last) {
      let chronicleId: string | null = null;
      const persistEntry: ChronicleEntryPayload = {
        ...last,
        source: "auto",
        context: (last.context || text).slice(0, getChronicleMaxContextChars(conf)),
        context_embedding:
          last.context_embedding?.length === HSS_CONTEXT_EMBEDDING_DIM
            ? last.context_embedding
            : encodeHssContext(text),
        importance: clampImportance(last.importance, autoImportance),
        rho_dim: getNodeRhoDim(node),
        field_snapshot: (() => {
          const fm = fieldMetrics ?? entry.fieldMetrics;
          return fm ? fieldSnapshotFromMetrics(fm, getNodeRhoDim(node)) : last.field_snapshot;
        })(),
      };
      if (options?.llmClient) {
        try {
          const semanticEmbedding = await getEmbedding(options.llmClient, conf, persistEntry.context || text);
          chronicleId = await persistChronicleEntry(conf, sessionId, cacheId, persistEntry, {
            semanticEmbedding,
            source: "auto",
          });
        } catch (err) {
          hssLog(
            "chronicle_persist_skipped",
            {
              sessionId,
              cacheId,
              reason: "semantic_embedding_failed",
              error: err instanceof Error ? err.message : String(err),
            },
            conf
          );
        }
      } else {
        hssLog(
          "chronicle_persist_skipped",
          { sessionId, cacheId, reason: "no_llm_client_for_semantic_embedding" },
          conf
        );
      }
      persisted = !!chronicleId;
      hssLog(
        "chronicle_persisted",
        {
          sessionId,
          cacheId,
          chronicleId,
          timestamp: persistEntry.timestamp,
          entropy: persistEntry.entropy,
          coherence: persistEntry.coherence,
          importance: persistEntry.importance,
          source: persistEntry.source,
          hasRho: !!persistEntry.rho,
          contextLen: persistEntry.context.length,
        },
        conf
      );
    } else {
      hssLog("chronicle_persist_skipped", { sessionId, cacheId, reason: "no_chronicle_entry" }, conf);
    }
  }

  const inv = node.check_topological_invariant();
  const coherence = node.measure_coherence ? node.measure_coherence() : (inv as { trace?: number }).trace ?? 0;
  const status = (inv.status === "STABLE" ? "STABLE" : "FRAGMENTED") as "STABLE" | "FRAGMENTED";
  const settled =
    status === "STABLE" && (typeof coherence === "number" ? coherence > COHERENCE_SETTLED_MIN : false);
  const entropy = typeof evolveResult?.S === "number" ? evolveResult.S : (last?.entropy ?? 0);

  if (fieldEnabled && contextEmbedding?.length) {
    fieldMetrics = computeFieldNodeMetrics({
      text,
      embedding: contextEmbedding,
      signatureEmbedding: entry.signatureAnchor ?? null,
      chronicleEmbeddings: chronicleEmbeddingsFromNode(node),
      purity: typeof coherence === "number" ? coherence : 1,
      entropy,
      prevEntropy: baselineEntropy,
      topologicalOk: inv.ok !== false,
      chaosScore,
      chronicleDepth: chronicleSizeAfter,
      signatureSeed: entry.signatureSeed ?? 0,
      stepIndex: chronicleSizeAfter,
      prevSemantic: entry.prevSemantic ?? null,
      config: conf,
    });
    entry.prevSemantic = fieldMetrics.semantic;
    entry.fieldMetrics = fieldMetrics;
    entry.rhoDim = getNodeRhoDim(node);
  }

  const rhoDimNow = getNodeRhoDim(node);

  hssLog(
    "evolve",
    {
      sessionId,
      cacheId,
      ...hssContextFields(context),
      evolveEntropy: evolveResult?.S,
      evolveCoherence: evolveResult?.coh,
      coherence: typeof coherence === "number" ? coherence : 0,
      entropy,
      entropyDelta,
      maxChunkEntropyDelta,
      sumPositiveChunkDelta,
      chunkCount,
      chaosScore,
      effectiveDelta,
      calibrationTurn,
      restoredFromChronicle: entry.restoredFromChronicle,
      entropyDeltaStabilizeMin: getHssEntropyDeltaStabilizeMin(conf),
      contextChunkSize: getHssContextChunkSize(conf),
      contextChunkMinLen: getHssContextChunkMinLen(conf),
      status,
      settled,
      settledThreshold: COHERENCE_SETTLED_MIN,
      chronicleSizeBefore,
      chronicleSizeAfter,
      chronicleConfigured: isChronicleChromaConfigured(conf),
      persisted,
      lastEntryEntropy: last?.entropy,
      lastEntryCoherence: last?.coherence,
      lastEntryImportance: last?.importance,
      ...(fieldMetrics
        ? {
            fieldP: fieldMetrics.semantic.P,
            fieldC: fieldMetrics.capacity,
            fieldPhi: fieldMetrics.phiIntegrated,
            fieldDim: fieldMetrics.effectiveDim,
            fieldKnot: fieldMetrics.knotScore,
            fieldResonance: fieldMetrics.resonance,
            fieldStable: fieldMetrics.topologicallyStable,
            fieldGradS: fieldMetrics.flux.gradS,
            rhoDim: rhoDimNow,
          }
        : {}),
    },
    conf
  );

  return {
    coherence: typeof coherence === "number" ? coherence : 0,
    status,
    settled,
    entropy,
    entropyDelta,
    maxChunkEntropyDelta,
    sumPositiveChunkDelta,
    chunkCount,
    chaosScore,
    effectiveDelta,
    restoredFromChronicle: entry.restoredFromChronicle,
    calibrationTurn,
    field: fieldMetrics,
    rhoDim: rhoDimNow,
  };
}

/**
 * Explicit entry into the session chronicle from the model (importance specifies the model).
 * Adds an entry to an HSS node and persists in Chroma with semantic embedding.
 */
export async function appendModelChronicleEntry(
  sessionId: string,
  cacheId: string,
  text: string,
  importance: number | undefined,
  client: OpenAI,
  config: Claw2Config
): Promise<{ ok: boolean; id?: string; reason?: string }> {
  const trimmed = text?.trim();
  if (!trimmed) return { ok: false, reason: "empty_text" };
  if (!isHssEnabled(config)) return { ok: false, reason: "hss_disabled" };

  const hss = getHss(config);
  if (!hss?.ChronicleEntry) return { ok: false, reason: "hss_unavailable" };

  const entryWrap = await getOrCreateNode(sessionId, cacheId, config);
  if (!entryWrap) return { ok: false, reason: "node_unavailable" };

  const node = entryWrap.node as EvolveNode & {
    chronicle?: { add: (e: unknown) => void; entries?: unknown[] };
    measure_coherence?: () => number;
    entropy?: () => number;
  };

  const imp = clampImportance(importance, getDefaultModelChronicleImportance(config));
  const maxChars = getChronicleMaxContextChars(config);
  const context = trimmed.slice(0, maxChars);
  const timestamp = Date.now();
  const hssEmb = encodeHssContext(context);

  let coherence = 1;
  let entropy = 0;
  if (typeof node.measure_coherence === "function") coherence = node.measure_coherence();
  const entries = node.chronicle?.entries;
  if (Array.isArray(entries) && entries.length > 0) {
    const prev = entries[entries.length - 1] as { entropy?: number };
    entropy = typeof prev.entropy === "number" ? prev.entropy : 0;
  }

  const { ChronicleEntry } = hss;
  const chronicleEntry = new ChronicleEntry({
    timestamp,
    entropy,
    coherence,
    context,
    context_embedding: hssEmb,
    xi_used: null,
    rho: null,
    importance: imp,
  });
  node.chronicle?.add(chronicleEntry);

  if (!isChronicleChromaConfigured(config)) {
    hssLog(
      "chronicle_model_saved",
      { sessionId, cacheId, importance: imp, contextLen: context.length, persisted: false },
      config
    );
    return { ok: true, reason: "in_memory_only" };
  }

  try {
    const semanticEmbedding = await getEmbedding(client, config, context);
    const payload: ChronicleEntryPayload = {
      timestamp,
      entropy,
      coherence,
      context,
      context_embedding: hssEmb,
      xi_used: null,
      rho: null,
      importance: imp,
      source: "model",
    };
    const id = await persistChronicleEntry(config, sessionId, cacheId, payload, {
      semanticEmbedding,
      source: "model",
    });
    if (!id) return { ok: false, reason: "persist_failed" };
    hssLog(
      "chronicle_model_saved",
      {
        sessionId,
        cacheId,
        chronicleId: id,
        importance: imp,
        contextLen: context.length,
        persisted: true,
      },
      config
    );
    return { ok: true, id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    hssLog("chronicle_model_saved", { sessionId, cacheId, error: msg, persisted: false }, config);
    return { ok: false, reason: msg };
  }
}
