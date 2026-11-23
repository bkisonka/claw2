// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/** Messages between the content script and the background service worker. */

export interface CompanionConfig {
  gatewayUrl: string;
  apiKey: string;
}

export interface PageContextPayload {
  text?: string;
  snippet?: string;
  url?: string;
  title?: string;
}

export type PortMessage =
  | { type: "chat"; sessionId?: string; message: string; pageContext: PageContextPayload; browserPageText?: string; browserPageKey?: string; chatTitle?: string }
  | { type: "abort" };

export type PortEvent =
  | { type: "chunk"; content: string }
  | { type: "openBrowserUrl"; url: string }
  | { type: "done"; sessionId?: string; content?: string; error?: string }
  | { type: "error"; error: string };

export interface HistoryMessage {
  role: "user" | "assistant" | string;
  content: string;
}

/** Ported from web/src/browser/pageKey.ts (pure module, same rules). */
export function normalizePageKey(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    const params = new URLSearchParams(u.search);
    for (const junk of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) {
      params.delete(junk);
    }
    u.search = params.toString();
    let host = u.host.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return `${host}${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

/** Escape-then-format: nothing from the page or the model reaches innerHTML raw. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Tiny markdown-lite renderer for the overlay: code, bold, links, breaks. */
export function renderMarkdownLite(text: string): string {
  const escaped = escapeHtml(text);
  const codeBlocks: string[] = [];
  let s = escaped.replace(/```([\s\S]*?)```/g, (_m, code: string) => {
    codeBlocks.push(code.replace(/^\n+|\n+$/g, ""));
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });
  s = s
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\n/g, "<br />");
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_m, i: string) => {
    return `<pre><code>${codeBlocks[Number(i)] ?? ""}</code></pre>`;
  });
  return s;
}
