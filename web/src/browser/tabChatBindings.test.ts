// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it } from "vitest";
import {
  resolveTabSession,
  prunePageKeyIndex,
  type PageKeyIndex,
} from "./tabChatBindings";

describe("resolveTabSession (unified chat)", () => {
  it("uses sharedSessionId for about:blank", () => {
    const { binding, pageChanged } = resolveTabSession({
      tabId: "t1",
      url: "about:blank",
      sharedSessionId: "sess_shared",
    });
    expect(binding.pageKey).toBeUndefined();
    expect(binding.sessionId).toBe("sess_shared");
    expect(pageChanged).toBe(false);
  });

  it("keeps shared session when blank navigates to a URL", () => {
    const blank = resolveTabSession({
      tabId: "t1",
      url: "about:blank",
      sharedSessionId: "sess_shared",
    });
    const navigated = resolveTabSession({
      tabId: "t1",
      url: "https://example.com/a",
      title: "A",
      prev: blank.binding,
      sharedSessionId: "sess_shared",
    });
    expect(navigated.binding.sessionId).toBe("sess_shared");
    expect(navigated.binding.pageKey).toBe("https://example.com/a");
    expect(navigated.pageChanged).toBe(true);
    expect(navigated.binding.pendingVisitMarker).toBe(true);
  });

  it("does not switch session for a different pageKey", () => {
    const first = resolveTabSession({
      tabId: "t1",
      url: "https://example.com/a",
      title: "A",
      sharedSessionId: "sess_shared",
    });
    const second = resolveTabSession({
      tabId: "t1",
      url: "https://example.com/b",
      title: "B",
      prev: first.binding,
      sharedSessionId: "sess_shared",
    });
    expect(second.binding.sessionId).toBe("sess_shared");
    expect(second.binding.pageKey).toBe("https://example.com/b");
    expect(second.pageChanged).toBe(true);
    expect(second.binding.pendingVisitMarker).toBe(true);
  });

  it("two tabs share the same session id", () => {
    const a = resolveTabSession({
      tabId: "t1",
      url: "https://example.com/a",
      sharedSessionId: "sess_shared",
    });
    const b = resolveTabSession({
      tabId: "t2",
      url: "https://habr.com/ru/news/1/",
      sharedSessionId: "sess_shared",
    });
    expect(a.binding.sessionId).toBe(b.binding.sessionId);
  });

  it("does not mark visit on same-tab reload", () => {
    const first = resolveTabSession({
      tabId: "t1",
      url: "https://example.com/a",
      sharedSessionId: "sess_shared",
    });
    const reload = resolveTabSession({
      tabId: "t1",
      url: "https://example.com/a",
      prev: first.binding,
      sharedSessionId: "sess_shared",
    });
    expect(reload.binding.sessionId).toBe("sess_shared");
    expect(reload.pageChanged).toBe(false);
    expect(reload.binding.pendingVisitMarker).toBe(false);
  });

  it("keeps page meta when URL briefly blanks", () => {
    const first = resolveTabSession({
      tabId: "t1",
      url: "https://example.com/a",
      sharedSessionId: "sess_shared",
    });
    const blank = resolveTabSession({
      tabId: "t1",
      url: "about:blank",
      prev: first.binding,
      sharedSessionId: "sess_shared",
    });
    expect(blank.binding.sessionId).toBe("sess_shared");
    expect(blank.binding.pageKey).toBe(first.binding.pageKey);
  });

  it("prunePageKeyIndex drops unknown sessions", () => {
    const index: PageKeyIndex = {
      "https://a.com/": "sess_keep",
      "https://b.com/": "sess_gone",
    };
    const next = prunePageKeyIndex(index, new Set(["sess_keep"]));
    expect(next).toEqual({ "https://a.com/": "sess_keep" });
  });
});
