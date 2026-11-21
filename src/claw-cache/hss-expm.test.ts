// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Run: npx tsx src/claw-cache/hss-expm.test.ts
 * Guarantees unitary evolve uses block expm at rhoDim=11 (no identity fallback from short ξ).
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { RHO_DIM_FULL } from "./hss-rho-dimension.js";

const require = createRequire(import.meta.url);
const hss = require("../../hss.cjs") as {
  INTENTION_XI_DEFAULT_SIZE: number;
  IntentionModule: new (sig: string, size?: number) => {
    xi_vector: number[];
    get_xi_slice: (n: number) => number[];
  };
  ContextEncoder: new (size?: number) => { encode: (s: string) => number[] };
  TopologicalNode: new (
    dim: number,
    intention: unknown
  ) => {
    dim: number;
    contextEncoder: unknown;
    evolve: (opts: Record<string, unknown>) => {
      S: number;
      coh: number;
      expmFallback?: string;
    };
  };
  buildHamiltonianFromEmbedding: (
    emb: number[],
    dim: number,
    intention: unknown,
    mix?: number
  ) => { re: number[][]; im: number[][] };
};

assert.ok(hss.INTENTION_XI_DEFAULT_SIZE >= RHO_DIM_FULL * RHO_DIM_FULL);

{
  const intention = new hss.IntentionModule("expm-test-sig");
  assert.ok(intention.xi_vector.length >= RHO_DIM_FULL * RHO_DIM_FULL);
  const slice = intention.get_xi_slice(RHO_DIM_FULL * RHO_DIM_FULL);
  assert.equal(slice.length, RHO_DIM_FULL * RHO_DIM_FULL);
  assert.ok(slice.every((x) => Number.isFinite(x)));
}

{
  const intention = new hss.IntentionModule("short-xi", 64);
  const slice = intention.get_xi_slice(121);
  assert.equal(slice.length, 121);
  assert.ok(slice.every((x) => Number.isFinite(x)));
}

{
  const enc = new hss.ContextEncoder(64);
  const intention = new hss.IntentionModule("ham-test");
  const emb = enc.encode("hamiltonian finite at full rho dim");
  const H = hss.buildHamiltonianFromEmbedding(emb, RHO_DIM_FULL, intention, 0.55);
  let nan = 0;
  for (let i = 0; i < RHO_DIM_FULL; i++) {
    for (let j = 0; j < RHO_DIM_FULL; j++) {
      if (!Number.isFinite(H.re[i]![j]!) || !Number.isFinite(H.im[i]![j]!)) nan++;
    }
  }
  assert.equal(nan, 0, "H must be finite at rhoDim=11");
}

{
  const enc = new hss.ContextEncoder(64);
  const intention = new hss.IntentionModule("evolve-block");
  const node = new hss.TopologicalNode(RHO_DIM_FULL, intention);
  node.contextEncoder = enc;
  const emb = enc.encode("evolve must use block expm not identity");
  const r = node.evolve({
    dt: 0.1,
    context: "evolve must use block expm not identity",
    contextEmbedding: emb,
    saveToChronicle: false,
    fieldFlux: { phi: 0.39, gamma: 0.3, xi: 0.2 },
  });
  assert.equal(
    r.expmFallback,
    undefined,
    `expected block expm, got fallback=${r.expmFallback}`
  );
  assert.ok(Number.isFinite(r.S) && Number.isFinite(r.coh));
}

console.log("hss-expm.test.ts: ok");
