/**
 * Types for .claw-cache (format from claw-cache.md).
 */

export interface ClawCacheManifest {
  format_version?: string;
  cache_id: string;
  name?: string;
  description?: string;
  domain?: string;
  language?: string;
  created_at?: string;
  creation_method?: string;
  generator_model?: string;
  author?: string;
  base_model_hint?: string;
  min_context_tokens?: number;
  activation_depth_score?: number;
  validation_status?: string;
  license?: string;
}

export interface ClawCacheTriggers {
  phrases?: string[];
  patterns?: string[];
  style_markers?: Record<string, unknown>;
  activation_turn?: number;
  peak_depth_turn?: number;
}

/** Chain of activation vectors from activation/vector.npy.*/
export interface ClawCacheActivationVector {
  /** [N][dim] float32 rows */
  rows: number[][];
  contexts: string[];
  dim: number;
  encoder: string;
}

export interface ClawCacheContent {
  manifest: ClawCacheManifest;
  triggers: ClawCacheTriggers | null;
  /** Raw dialogue text (activation/dialogue.jsonl) - do not insert into prompts without checking.*/
  dialogueRaw: string | null;
  /** A chain of state vectors (HSS 64-dim), if vector.npy is valid.*/
  activationVector: ClawCacheActivationVector | null;
  /** Whether the scan passed for injection (text from the cache is allowed for substitution).*/
  passedInjectionScan: boolean;
  /** The path or identifier where it was downloaded from.*/
  source: string;
}
