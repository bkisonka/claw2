/**
 * Packaging content in .claw-cache (ZIP) according to the specifications of claw-cache.md.
 */

import { createHash } from "node:crypto";
import JSZip from "jszip";
import type { ClawCacheManifest, ClawCacheTriggers } from "./types.js";
import {
  activationVectorToNpyBuffer,
  buildActivationVectorFromDialogueJsonl,
  type ActivationVectorMatrix,
} from "./activation-vector.js";

const FORMAT_VERSION = "1.0";

export interface ClawCachePackInput {
  manifest?: Partial<ClawCacheManifest>;
  triggers?: Partial<ClawCacheTriggers>;
  dialogueJsonl?: string;
  /** Finished chain; if not, it is built from dialogueJsonl (HSS 64-dim).*/
  activationVector?: ActivationVectorMatrix;
  generator_prompt?: string;
  generator_model?: Record<string, unknown>;
  quality_metrics?: Record<string, unknown>;
  adapter_hints?: Record<string, unknown>;
  rag_profile?: Record<string, unknown>;
}

function defaultManifest(overrides: Partial<ClawCacheManifest> = {}): ClawCacheManifest {
  return {
    format_version: FORMAT_VERSION,
    cache_id: "",
    name: "",
    description: "",
    domain: "",
    language: "ru",
    created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    creation_method: "session-export",
    generator_model: "",
    author: "",
    base_model_hint: "any",
    min_context_tokens: 2048,
    activation_depth_score: 0.9,
    validation_status: "pending",
    license: "CC-BY-NC-4.0",
    ...overrides,
  };
}

function defaultTriggers(overrides: Partial<ClawCacheTriggers> = {}): ClawCacheTriggers {
  return {
    phrases: [],
    patterns: [],
    style_markers: {},
    activation_turn: 8,
    peak_depth_turn: 14,
    ...overrides,
  };
}

function defaultQualityMetrics(dialogueTurns: number, overrides: Record<string, unknown> = {}) {
  return {
    dialogue_length: dialogueTurns,
    avg_response_depth: 0,
    expert_pattern_coverage: 0,
    toxicity_score: 0,
    hallucination_flags: 0,
    consistency_score: 0,
    validation_queries_passed: 0,
    validation_queries_total: 0,
    ...overrides,
  };
}

async function buildZipWithoutChecksum(content: ClawCachePackInput): Promise<JSZip> {
  const zip = new JSZip();

  const manifest = defaultManifest(content.manifest);
  if (!manifest.cache_id) manifest.cache_id = `export-${Date.now()}`;
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  const triggers = defaultTriggers(content.triggers);
  zip.file("activation/triggers.json", JSON.stringify(triggers, null, 2));

  const dialogueJsonl = (content.dialogueJsonl ?? "").trim();
  zip.file("activation/dialogue.jsonl", dialogueJsonl ? `${dialogueJsonl}\n` : "");

  const matrix =
    content.activationVector ??
    (dialogueJsonl ? buildActivationVectorFromDialogueJsonl(dialogueJsonl) : null);
  const npyBuf = matrix
    ? activationVectorToNpyBuffer(matrix)
    : activationVectorToNpyBuffer({
        rows: [],
        contexts: [],
        dim: 64,
        encoder: "hss-context-64",
      });
  zip.file("activation/vector.npy", npyBuf);
  zip.file(
    "activation/vector.meta.json",
    JSON.stringify(
      {
        encoder: matrix?.encoder ?? "hss-context-64",
        dim: matrix?.dim ?? 64,
        turns: matrix?.rows.length ?? 0,
        format: "npy-float32-c",
      },
      null,
      2
    )
  );

  zip.file("generation/generator_prompt.txt", content.generator_prompt ?? "Exported from claw2 session.");
  zip.file("generation/generator_model.json", JSON.stringify(content.generator_model ?? {}, null, 2));

  const turnCount = dialogueJsonl ? dialogueJsonl.split("\n").filter(Boolean).length : 0;
  zip.file(
    "generation/quality_metrics.json",
    JSON.stringify(
      defaultQualityMetrics(turnCount, {
        activation_vector_turns: matrix?.rows.length ?? 0,
        activation_vector_dim: matrix?.dim ?? 64,
        ...content.quality_metrics,
      }),
      null,
      2
    )
  );

  zip.file("usage/adapter-hints.json", JSON.stringify(content.adapter_hints ?? {}, null, 2));
  zip.file("usage/rag-profile.json", JSON.stringify(content.rag_profile ?? {}, null, 2));
  zip.file("security/signature.sig", "");

  return zip;
}

/** ZIP buffer .claw-cache with checksum.sha256.*/
export async function packToClawCache(content: ClawCachePackInput): Promise<Buffer> {
  const zip = await buildZipWithoutChecksum(content);
  const bufferWithoutChecksum = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  const checksumHex = createHash("sha256").update(bufferWithoutChecksum).digest("hex");
  zip.file("security/checksum.sha256", checksumHex);
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}
