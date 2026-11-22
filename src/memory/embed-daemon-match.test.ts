// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * embedDaemonMatches: the reuse predicate for the shared embed daemon. A
 * stale daemon serving another model/dim must NOT be reused — that fed the
 * memory store wrong-dimension vectors ("got 96, expected 384").
 *
 * Run: npx tsx src/memory/embed-daemon-match.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { embedDaemonMatches, type SharedEmbedHealthInfo } from "./embed-daemon.js";
import { DEFAULT_LOCAL_EMBEDDING_MODEL, resolveLocalEmbeddingModel } from "./embedding.js";
import type { Claw2Config } from "../config/types.js";

describe("resolveLocalEmbeddingModel", () => {
  const cfg = (memory?: Claw2Config["memory"]): Claw2Config => ({ memory }) as Claw2Config;

  it("accepts a HuggingFace repo id and defaults to bge-small", () => {
    assert.equal(
      resolveLocalEmbeddingModel(cfg({ embeddingModel: "Xenova/bge-small-en-v1.5" })),
      "Xenova/bge-small-en-v1.5"
    );
    assert.equal(resolveLocalEmbeddingModel(cfg()), DEFAULT_LOCAL_EMBEDDING_MODEL);
  });

  it("ignores HTTP-API model names — they are not HF repos (the sqlite-backend trap)", () => {
    assert.equal(
      resolveLocalEmbeddingModel(cfg({ enabled: true, backend: "sqlite", embeddingModel: "text-embedding-3-small" })),
      DEFAULT_LOCAL_EMBEDDING_MODEL,
      "an API-style id must not reach the local daemon"
    );
  });
});

describe("embedDaemonMatches", () => {
  const want = { model: "Xenova/bge-small-en-v1.5", dim: 384 };

  it("matches a healthy daemon with the exact model and dim", () => {
    const info: SharedEmbedHealthInfo = { ok: true, model: want.model, dim: 384 };
    assert.equal(embedDaemonMatches(info, want.model, want.dim), true);
  });

  it("rejects another model, another dim, and an unhealthy daemon", () => {
    assert.equal(
      embedDaemonMatches({ ok: true, model: "other/model", dim: 384 }, want.model, want.dim),
      false,
      "different model must not be reused",
    );
    assert.equal(
      embedDaemonMatches({ ok: true, model: want.model, dim: 96 }, want.model, want.dim),
      false,
      "the 96-dim regression case",
    );
    assert.equal(
      embedDaemonMatches({ ok: false, model: want.model, dim: 384 }, want.model, want.dim),
      false,
      "unhealthy daemon is not a match",
    );
    assert.equal(embedDaemonMatches(null, want.model, want.dim), false, "no daemon at all");
  });

  it("treats missing model/dim fields as a mismatch", () => {
    assert.equal(embedDaemonMatches({ ok: true }, want.model, want.dim), false);
    assert.equal(embedDaemonMatches({ ok: true, model: want.model }, want.model, want.dim), false);
  });
});
