// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { describe, it, expect, beforeEach } from "vitest";
import {
  sidebarClear,
  sidebarClick,
  sidebarGet,
  sidebarGetSnapshot,
  sidebarMark,
  sidebarMigrate,
  sidebarRemove,
  sidebarSet,
  sidebarUpsert,
} from "./store.js";

const SID = "test-sidebar-api";

beforeEach(() => {
  sidebarClear(SID);
});

describe("sidebar store API", () => {
  it("set + get snapshot with chrome rules", () => {
    const r = sidebarSet(SID, {
      title: "Next",
      items: [
        { id: "a", label: "Do A", action: "prompt", value: "do a", status: "open" },
        { id: "b", label: "Skills", action: "navigate", value: "/cabinet/skills" },
      ],
    });
    expect(r.ok).toBe(true);
    const snap = sidebarGetSnapshot(SID);
    expect(snap.contextual.items).toHaveLength(2);
    expect(snap.chrome.rules.length).toBeGreaterThan(0);
    expect(snap.summary).toContain("id=a");
  });

  it("upsert updates by id and appends new", () => {
    sidebarSet(SID, {
      items: [{ id: "a", label: "Old", action: "prompt", value: "old" }],
    });
    const r = sidebarUpsert(SID, {
      items: [
        { id: "a", label: "New", action: "prompt", value: "new", status: "active" },
        { id: "c", label: "C", action: "prompt", value: "c" },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.items).toHaveLength(2);
    expect(r.state.items.find((i) => i.id === "a")?.label).toBe("New");
    expect(r.state.items.find((i) => i.id === "a")?.status).toBe("active");
  });

  it("remove + mark + click", () => {
    sidebarSet(SID, {
      items: [
        { id: "a", label: "A", action: "prompt", value: "a" },
        { id: "b", label: "B", action: "prompt", value: "b" },
      ],
    });
    expect(sidebarRemove(SID, { ids: ["b"] }).ok).toBe(true);
    expect(sidebarGet(SID).items.map((i) => i.id)).toEqual(["a"]);
    expect(sidebarMark(SID, { id: "a", status: "active" }).ok).toBe(true);
    const click = sidebarClick(SID, "a");
    expect(click.ok).toBe(true);
    if (!click.ok) return;
    expect(click.item.status).toBe("done");
    expect(sidebarGet(SID).lastEvent?.type).toBe("click");
  });

  it("preserves recent click lastEvent across set/upsert", () => {
    sidebarSet(SID, {
      items: [{ id: "a", label: "A", action: "prompt", value: "do a" }],
    });
    expect(sidebarClick(SID, "a").ok).toBe(true);
    expect(sidebarGet(SID).lastEvent?.type).toBe("click");
    sidebarSet(SID, {
      title: "Next",
      items: [{ id: "b", label: "B", action: "prompt", value: "do b" }],
    });
    expect(sidebarGet(SID).lastEvent?.type).toBe("click");
    expect(sidebarGet(SID).lastEvent?.detail).toContain("then set");
    sidebarUpsert(SID, {
      items: [{ id: "b", label: "B2", action: "prompt", value: "do b2" }],
    });
    expect(sidebarGet(SID).lastEvent?.type).toBe("click");
  });

  it("migrate moves state and clears source", () => {
    sidebarSet("anon", {
      title: "T",
      items: [{ id: "a", label: "A", action: "prompt", value: "a" }],
    });
    const moved = sidebarMigrate("anon", SID);
    expect(moved?.items).toHaveLength(1);
    expect(sidebarGet("anon").items).toHaveLength(0);
    expect(sidebarGet(SID).title).toBe("T");
  });
});
