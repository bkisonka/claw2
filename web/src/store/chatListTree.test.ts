// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forkTreeIds, isInForkTree } from "./chatList";

const tree = [
  { id: "a", forkedFrom: null },
  { id: "b", forkedFrom: "a" },
  { id: "c", forkedFrom: "b" },
  { id: "d", forkedFrom: "a" },
  { id: "e", forkedFrom: null },
  { id: "f", forkedFrom: "ghost" }, // parent outside the list — own island root
];

describe("fork tree helpers", () => {
  it("detects tree membership in both directions", () => {
    assert.equal(isInForkTree(tree, "a"), true, "root with children");
    assert.equal(isInForkTree(tree, "c"), true, "leaf with parent");
    assert.equal(isInForkTree(tree, "e"), false, "standalone chat");
    assert.equal(isInForkTree(tree, "f"), false, "orphaned fork parent not in list");
    assert.equal(isInForkTree(tree, "missing"), false);
  });

  it("collects the whole tree from any member, order-independent as a set", () => {
    for (const id of ["a", "b", "c", "d"]) {
      assert.deepEqual(new Set(forkTreeIds(tree, id)), new Set(["a", "b", "c", "d"]), `from ${id}`);
    }
    assert.deepEqual(forkTreeIds(tree, "e"), ["e"]);
    assert.deepEqual(forkTreeIds(tree, "f"), ["f"], "orphaned fork is its own tree");
    assert.deepEqual(forkTreeIds(tree, "missing"), ["missing"]);
  });

  it("cannot loop on corrupted cyclic lineage", () => {
    const cyclic = [
      { id: "x", forkedFrom: "y" },
      { id: "y", forkedFrom: "x" },
      { id: "z", forkedFrom: "x" },
    ];
    const ids = forkTreeIds(cyclic, "z");
    assert.deepEqual(new Set(ids), new Set(["x", "y", "z"]));
  });
});
