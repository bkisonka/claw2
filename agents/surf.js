// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

// Agent: Parse URL (HTML/RSS/Atom/JSON Feed) → structured JSON
// Call: run_agent({script:"surf.js", args:["https://…"]})
// In: argv[2]=URL
// Out: stdout: JSON { title, articles, … }

import { createRequire } from "node:module";
import { URL } from "node:url";

const require = createRequire(import.meta.url);
const cheerio = require("cheerio");
const Parser = require("rss-parser");

const RAW_URLS = process.argv.slice(2).map((s) => s?.trim()).filter(Boolean);
const MAX_URLS = 10;
const TIMEOUT_MS = 20000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_HTML_PARSE_BYTES = 512 * 1024;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; rv:109.0) Gecko/20100101 Firefox/115.0";

function parseUrl(s) {
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

function isPrivateHost(hostname) {
  if (!hostname || typeof hostname !== "string") return true;
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  const parts = hostname.split(".");
  if (parts.length === 4) {
    const a = parseInt(parts[0], 10) | 0;
    const b = parseInt(parts[1], 10) | 0;
    if (a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
  }
  if (hostname.startsWith("[") && (lower.includes("::1") || lower.includes("fe80"))) return true;
  return false;
}

const URLS = RAW_URLS
  .map((u) => parseUrl(u))
  .filter((u) => u && !isPrivateHost(u?.hostname))
  .map((u) => u.href)
  .slice(0, MAX_URLS);

if (URLS.length === 0) {
  console.error("Usage: node surf.js <url> [url2 ...]");
  process.exit(1);
}

function strip(str) {
  if (typeof str !== "string") return "";
  return str.replace(/\s+/g, " ").replace(/\n\s*\n/g, "\n\n").trim();
}

function firstLine(str, maxLen = 300) {
  const s = strip(str);
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLen / 2 ? cut.slice(0, lastSpace) : cut) + "…";
}

function stripHtml(html) {
  if (typeof html !== "string" || !html.trim()) return "";
  try {
    const $ = cheerio.load(html);
    return strip($.root().text() ?? "");
  } catch {
    return strip(html.replace(/<[^>]+>/g, " "));
  }
}

async function fetchBody(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html, application/xhtml+xml, application/xml;q=0.9, application/json;q=0.8, */*;q=0.7",
      },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) throw new Error("Response too large");
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    return { text, contentType };
  } finally {
    clearTimeout(t);
  }
}

function tryJsonFeed(text) {
  try {
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.items) || !data.items[0]) return null;
    const item = data.items[0];
    let content = item.content_text || "";
    if (!content && item.content_html) {
      try {
        const $ = cheerio.load(item.content_html);
        content = $.root().text() ?? "";
      } catch {}
    }
    return {
      title: item.title ?? "",
      author: item.authors?.[0]?.name ?? item.author?.name ?? "",
      published: item.date_published ?? item.date_modified ?? "",
      content: strip(content),
      summary: firstLine(item.summary || content),
    };
  } catch {
    return null;
  }
}

async function tryRssOrAtom(text, contentType) {
  if (
    !contentType.includes("xml") &&
    !contentType.includes("rss") &&
    !contentType.includes("atom") &&
    !text.trimStart().startsWith("<?xml") &&
    !text.trimStart().startsWith("<rss") &&
    !text.trimStart().startsWith("<feed")
  ) {
    return null;
  }
  const parser = new Parser({
    customFields: {
      item: ["dc:creator", "author", "content:encoded"],
    },
  });
  let feed;
  try {
    feed = await parser.parseString(text);
  } catch {
    return null;
  }
  const item = feed.items?.[0];
  if (!item) {
    return {
      title: feed.title ?? "",
      author: "",
      published: "",
      content: "",
      summary: feed.description ?? "",
    };
  }
  const author =
    item.creator ??
    item["dc:creator"] ??
    (item.author ? (typeof item.author === "string" ? item.author : item.author.name) : "") ??
    "";
  const raw =
    item["content:encoded"] || item.content || item.contentSnippet || item.summary || "";
  const content = raw.includes("<") ? stripHtml(raw) : strip(raw);
  return {
    title: item.title ?? "",
    author: String(author).trim(),
    published: item.pubDate ?? item.isoDate ?? "",
    content,
    summary: firstLine(item.contentSnippet || item.summary || content),
  };
}

function tryHtml(text) {
  try {
    const toParse =
      text.length > MAX_HTML_PARSE_BYTES
        ? text.slice(0, MAX_HTML_PARSE_BYTES) + "\n"
        : text;
    const $ = cheerio.load(toParse);
    const title =
      $('meta[property="og:title"]').attr("content") ?? $("title").text() ?? "";
    const author =
      $('meta[name="author"]').attr("content") ??
      $('meta[property="article:author"]').attr("content") ??
      $('meta[property="og:article:author"]').attr("content") ??
      "";
    const published =
      $('meta[property="article:published_time"]').attr("content") ??
      $('meta[name="date"]').attr("content") ??
      $("time[datetime]").attr("datetime") ??
      "";
    const contentSelectors = [
      "article",
      "[role=main]",
      "main",
      ".post-content",
      ".article-body",
      ".entry-content",
      ".content",
      ".post-body",
      "#content",
      ".post",
      ".article",
    ];
    let rawContent = "";
    for (const sel of contentSelectors) {
      const el = $(sel).first();
      if (el.length) {
        const t = el.text().trim() || "";
        if (t.length > 100) {
          rawContent = t;
          break;
        }
      }
    }
    if (!rawContent) rawContent = $("body").text() ?? "";
    const content = strip(rawContent);
    const summary =
      $('meta[name="description"]').attr("content") ??
      $('meta[property="og:description"]').attr("content") ??
      firstLine(content);
    return {
      title: strip(title),
      author: strip(author),
      published: strip(published),
      content,
      summary: strip(summary) || firstLine(content),
    };
  } catch {
    return null;
  }
}

async function processOneUrl(url) {
  try {
    const { text, contentType } = await fetchBody(url);
    let result =
      tryJsonFeed(text) ??
      (await tryRssOrAtom(text, contentType)) ??
      tryHtml(text);
    if (!result) {
      result = {
        title: "",
        author: "",
        published: "",
        content: text.slice(0, 5000),
        summary: firstLine(text, 500),
      };
    }
    return { url, ...result };
  } catch (err) {
    const msg =
      err.name === "AbortError" ? "Timeout" : (err.message ?? String(err));
    return {
      url,
      title: "",
      author: "",
      published: "",
      content: "",
      summary: "",
      error: msg,
    };
  }
}

(async () => {
  try {
    const results = await Promise.all(URLS.map((url) => processOneUrl(url)));
    console.log(JSON.stringify({ results }, null, 2));
  } catch (err) {
    console.error("Fatal error:", err.message ?? String(err));
    process.exit(1);
  }
})();