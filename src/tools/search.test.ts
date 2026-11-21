// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { describe, it, expect } from "vitest";
import type { Claw2Config } from "../config/types.js";
import {
  buildBrowserSearchUrl,
  buildBrowserSearchUrlFromTemplate,
  buildSearxngSearchUrl,
  isSearchToolEnabled,
  parseSearchEnginesArg,
  pickBrowserSearchEngines,
  resolveBrowserSearchEngines,
  resolveSearchProviderOrder,
} from "./search.js";

function cfg(tools: Claw2Config["tools"]): Claw2Config {
  return { tools } as Claw2Config;
}

describe("search providers", () => {
  it("buildSearxngSearchUrl appends /search and format=json", () => {
    const u = buildSearxngSearchUrl("https://claw2.online", "hello world");
    expect(u).toContain("https://claw2.online/search?");
    expect(u).toContain("q=hello");
    expect(u).toContain("format=json");
  });

  it("buildSearxngSearchUrl keeps existing /search path", () => {
    const u = buildSearxngSearchUrl("https://claw2.online/search/", "x");
    expect(u.startsWith("https://claw2.online/search?")).toBe(true);
    expect(u).not.toContain("/search/search");
  });

  it("isSearchToolEnabled always (browser SERP and/or API fallback)", () => {
    expect(isSearchToolEnabled(cfg({}))).toBe(true);
    expect(isSearchToolEnabled(cfg({ tavily: { enabled: false } }))).toBe(true);
  });

  it("buildBrowserSearchUrl uses first enabled engine", () => {
    const u = buildBrowserSearchUrl("hello world");
    expect(u).toBe("https://html.duckduckgo.com/html/?q=hello%20world");
  });

  it("buildBrowserSearchUrlFromTemplate encodes query", () => {
    expect(buildBrowserSearchUrlFromTemplate("https://x.test/?q={query}", "a b")).toBe(
      "https://x.test/?q=a%20b"
    );
  });

  it("resolveBrowserSearchEngines merges defaults and custom", () => {
    const list = resolveBrowserSearchEngines(
      cfg({
        search: {
          browserEngines: [
            { id: "google", name: "Google", urlTemplate: "https://www.google.com/search?q={query}", enabled: false },
            {
              id: "bing",
              name: "Bing",
              urlTemplate: "https://www.bing.com/search?q={query}",
              enabled: true,
            },
          ],
        },
      })
    );
    expect(list.map((e) => e.id)).toEqual(["ddg", "google", "yandex", "bing"]);
    expect(list.find((e) => e.id === "google")?.enabled).toBe(false);
    expect(list.find((e) => e.id === "bing")?.name).toBe("Bing");
  });

  it("pickBrowserSearchEngines defaults to first enabled; all / multi", () => {
    const c = cfg({});
    expect(pickBrowserSearchEngines(c).map((e) => e.id)).toEqual(["ddg"]);
    expect(pickBrowserSearchEngines(c, ["all"]).map((e) => e.id)).toEqual([
      "ddg",
      "google",
      "yandex",
    ]);
    expect(pickBrowserSearchEngines(c, ["google", "ddg"]).map((e) => e.id)).toEqual([
      "ddg",
      "google",
    ]);
  });

  it("parseSearchEnginesArg accepts array or comma string", () => {
    expect(parseSearchEnginesArg(["Yandex", "google"])).toEqual(["Yandex", "google"]);
    expect(parseSearchEnginesArg("yandex, google")).toEqual(["yandex", "google"]);
    expect(parseSearchEnginesArg(undefined)).toBeUndefined();
  });

  it("resolveSearchProviderOrder respects provider preference", () => {
    const all = cfg({
      search: { provider: "auto" },
      tavily: { apiKey: "tvly-x" },
      searxng: { url: "http://127.0.0.1:8080" },
      other: { url: "https://search.example.com" },
    });
    expect(resolveSearchProviderOrder(all)).toEqual(["tavily", "searxng", "other"]);

    expect(
      resolveSearchProviderOrder(
        cfg({
          search: { provider: "searxng" },
          tavily: { apiKey: "tvly-x" },
          searxng: { url: "http://127.0.0.1:8080" },
        })
      )
    ).toEqual(["searxng"]);

    expect(
      resolveSearchProviderOrder(
        cfg({
          search: { provider: "tavily" },
          tavily: { apiKey: "tvly-x" },
          searxng: { url: "http://127.0.0.1:8080" },
        })
      )
    ).toEqual(["tavily"]);

    expect(
      resolveSearchProviderOrder(
        cfg({
          search: { provider: "other" },
          tavily: { apiKey: "tvly-x" },
          other: { url: "https://search.example.com" },
        })
      )
    ).toEqual(["other"]);
  });
});
