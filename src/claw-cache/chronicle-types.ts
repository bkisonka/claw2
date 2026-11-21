// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Shared types for HSS chronicle persistence (Chroma / sqlite-vec).
 */
import type { ChronicleEntrySource } from "./chronicle-importance.js";
import type { FieldSnapshot } from "./hss-field-ontology.js";

/** Chronicle entry for serialization (compatible with ChronicleEntry in hss.cjs).*/
export interface ChronicleEntryPayload {
  timestamp: number;
  entropy: number;
  coherence: number;
  context: string;
  context_embedding: number[];
  xi_used: { re: number[][]; im: number[][] } | null;
  rho: { re: number[][]; im: number[][] } | null;
  importance: number;
  source?: ChronicleEntrySource;
  /** A snapshot of 11D and field metrics (JSON in metadata).*/
  field_snapshot?: FieldSnapshot | null;
  rho_dim?: number;
}

export interface ChroniclePersistOptions {
  /** Semantic embedding for recall in prompts.*/
  semanticEmbedding?: number[];
  source?: ChronicleEntrySource;
}

/** The result of a semantic recall chronicle.*/
export interface ChronicleRecallHit {
  id: string;
  context: string;
  importance: number;
  timestamp: number;
  entropy: number;
  coherence: number;
  source: ChronicleEntrySource;
  similarity: number;
  score: number;
  pinned: boolean;
}

export interface ChronicleRecallOptions {
  limit?: number;
  minSimilarity?: number;
  pinImportanceMin?: number;
  maxPinned?: number;
}
