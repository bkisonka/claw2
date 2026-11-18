import { describe, expect, it, beforeEach } from "vitest";
import {
  loadUrlHistory,
  recordUrlVisit,
  removeUrlHistoryEntry,
  suggestUrlHistory,
} from "./urlHistory";

function installMemoryLocalStorage() {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
}

describe("urlHistory", () => {
  beforeEach(() => {
    installMemoryLocalStorage();
  });

  it("records visits and bumps count", () => {
    recordUrlVisit("https://example.com/a", "A");
    recordUrlVisit("https://example.com/a", "A2");
    const list = loadUrlHistory();
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("A2");
    expect(list[0]?.visitCount).toBe(2);
  });

  it("suggests by host and title", () => {
    recordUrlVisit("https://news.ycombinator.com/", "Hacker News");
    recordUrlVisit("https://example.com/docs", "Docs");
    expect(suggestUrlHistory("hack").map((e) => e.url)).toEqual([
      "https://news.ycombinator.com/",
    ]);
    expect(suggestUrlHistory("example").map((e) => e.url)[0]).toContain("example.com");
    expect(suggestUrlHistory("").length).toBe(2);
  });

  it("removes entries", () => {
    recordUrlVisit("https://a.test/", "A");
    recordUrlVisit("https://b.test/", "B");
    removeUrlHistoryEntry("https://a.test/");
    expect(loadUrlHistory().map((e) => e.url)).toEqual(["https://b.test/"]);
  });

  it("ignores about:blank", () => {
    recordUrlVisit("about:blank", "");
    expect(loadUrlHistory()).toHaveLength(0);
  });
});
