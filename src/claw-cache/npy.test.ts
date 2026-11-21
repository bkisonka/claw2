// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Run: npx tsx src/claw-cache/npy.test.ts
 */
import assert from "node:assert/strict";
import { readNpyFloat32, writeNpyFloat32, npyToRows, rowsToNpy } from "./npy.js";
import {
  activationVectorFromNpyBuffer,
  activationVectorToNpyBuffer,
  buildActivationVectorFromMessages,
} from "./activation-vector.js";

{
  const shape = [2, 3] as const;
  const data = new Float32Array([1, 2, 3, 4, 5, 6]);
  const buf = writeNpyFloat32(data, [...shape]);
  const back = readNpyFloat32(buf);
  assert.deepEqual(back.shape, [2, 3]);
  assert.equal(back.data.length, 6);
  assert.ok(Math.abs(back.data[0]! - 1) < 1e-6);
  assert.ok(Math.abs(back.data[5]! - 6) < 1e-6);
}

{
  const rows = [
    [0.1, 0.2, 0.3],
    [0.4, 0.5, 0.6],
  ];
  const npy = rowsToNpy(rows);
  const again = npyToRows(npy);
  assert.equal(again.length, 2);
  assert.ok(Math.abs(again[1]![2]! - 0.6) < 1e-6);
}

{
  const empty = writeNpyFloat32(new Float32Array(0), [0, 64]);
  const back = readNpyFloat32(empty);
  assert.deepEqual(back.shape, [0, 64]);
  assert.equal(back.data.length, 0);
}

{
  const matrix = buildActivationVectorFromMessages([
    { role: "user", content: "Привет, как дела с активацией векторов?" },
    { role: "assistant", content: "Цепочка векторов кодирует траекторию состояния." },
  ]);
  assert.equal(matrix.rows.length, 2);
  assert.equal(matrix.dim, 64);
  assert.equal(matrix.rows[0]!.length, 64);
  const buf = activationVectorToNpyBuffer(matrix);
  assert.ok(buf.length > 64);
  const parsed = activationVectorFromNpyBuffer(buf);
  assert.ok(parsed);
  assert.equal(parsed!.rows.length, 2);
  assert.equal(parsed!.dim, 64);
  // round-trip numeric
  for (let i = 0; i < 64; i++) {
    assert.ok(Math.abs(parsed!.rows[0]![i]! - matrix.rows[0]![i]!) < 1e-5);
  }
}

console.log("npy.test.ts: ok");
