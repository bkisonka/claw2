// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forkTreeIds, isInForkTree, serverChatToItem, upsertChatRowStable, type ChatItem } from "./chatList";
import type { ChatListItemApi } from "../api/chat";

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

describe("stable upsert during generation", () => {
  const row = (id: string, updatedAt: number, forkedFrom: string | null = null): ChatItem =>
    ({ id, title: id, updatedAt, messages: [], forkedFrom });

  it("keeps the list order while a streaming chat's updatedAt ticks", () => {
    let list = [row("old", 1), row("mid", 2), row("new", 3)];
    // Stream ticks on "old": its updatedAt grows past everything.
    for (const ts of [10, 11, 12, 13]) {
      list = upsertChatRowStable(list, { ...list.find((c) => c.id === "old")!, updatedAt: ts });
      assert.deepEqual(list.map((c) => c.id), ["old", "mid", "new"], `tick ${ts}`);
    }
  });

  it("inserts a brand-new chat at the top and keeps it there", () => {
    let list = [row("a", 1), row("b", 2)];
    list = upsertChatRowStable(list, row("fresh", 100));
    assert.deepEqual(list.map((c) => c.id), ["fresh", "a", "b"]);
    list = upsertChatRowStable(list, { ...list[0]!, updatedAt: 101 });
    assert.deepEqual(list.map((c) => c.id), ["fresh", "a", "b"]);
  });
});

describe("server row merge keeps attachment flags", () => {
  const apiRow = (over: Partial<ChatListItemApi> = {}): ChatListItemApi => ({
    id: "c1",
    title: "Server title",
    updated_at: 5,
    ...over,
  });

  it("copies hasImages/hasDocs from the server row", () => {
    const item = serverChatToItem(apiRow({ hasDocs: true }), undefined, null);
    assert.equal(item.id, "c1");
    assert.equal(item.hasDocs, true);
    assert.equal(item.hasImages, undefined);
  });

  it("keeps previous flags when the server omits them (search mode)", () => {
    const old: ChatItem = { id: "c1", title: "t", updatedAt: 1, messages: [], hasImages: true };
    const item = serverChatToItem(apiRow(), old, null);
    assert.equal(item.hasImages, true);
    assert.equal(item.hasDocs, undefined);
  });

  it("server flags win over stale local ones", () => {
    const old: ChatItem = { id: "c1", title: "t", updatedAt: 1, messages: [], hasDocs: true };
    const item = serverChatToItem(apiRow({ hasDocs: false }), old, null);
    assert.equal(item.hasDocs, false, "explicit server false clears the stale flag");
  });
});
