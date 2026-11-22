// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { enqueueMessage, moveQueued, removeQueued, takeNextQueued } from "./composerQueue";

describe("composer queue", () => {
  it("enqueues trimmed messages in FIFO order and ignores blanks", () => {
    let q = enqueueMessage([], "  первый  ");
    q = enqueueMessage(q, "второй");
    q = enqueueMessage(q, "   ");
    assert.deepEqual(q.map((m) => m.text), ["первый", "второй"]);
    assert.ok(q[0]?.id && q[1]?.id && q[0].id !== q[1].id, "items get unique ids");
  });

  it("removes by id", () => {
    let q = enqueueMessage(enqueueMessage([], "a"), "b");
    const firstId = q[0]!.id;
    q = removeQueued(q, firstId);
    assert.deepEqual(q.map((m) => m.text), ["b"]);
    q = removeQueued(q, "no-such-id");
    assert.deepEqual(q.map((m) => m.text), ["b"], "unknown id is a no-op");
  });

  it("moves items for drag reorder and no-ops bad indexes", () => {
    let q = enqueueMessage(enqueueMessage(enqueueMessage([], "a"), "b"), "c");
    q = moveQueued(q, 2, 0);
    assert.deepEqual(q.map((m) => m.text), ["c", "a", "b"]);
    assert.deepEqual(moveQueued(q, 1, 1), q, "same index is a no-op");
    assert.deepEqual(moveQueued(q, -1, 0), q, "negative index is a no-op");
    assert.deepEqual(moveQueued(q, 0, 99), q, "out-of-range index is a no-op");
  });

  it("takes the head by default, a forced item out of turn, and null when empty", () => {
    let q = enqueueMessage(enqueueMessage(enqueueMessage([], "a"), "b"), "c");
    const bId = q[1]!.id;

    const forced = takeNextQueued(q, bId);
    assert.equal(forced?.item.text, "b", "forced item jumps the queue");
    assert.deepEqual(forced?.rest.map((m) => m.text), ["a", "c"]);

    const head = takeNextQueued(q);
    assert.equal(head?.item.text, "a");
    assert.deepEqual(head?.rest.map((m) => m.text), ["b", "c"]);

    const missing = takeNextQueued(q, "no-such-id");
    assert.equal(missing?.item.text, "a", "missing forced id falls back to the head");

    assert.equal(takeNextQueued([], "whatever"), null);
  });
});
