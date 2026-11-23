// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * claw2 companion — content script. Renders the overlay in a Shadow DOM
 * (styles isolated from the page, the page cannot see inside): a small pill
 * on every page; click opens the panel — chat feed as an overlay, composer
 * pinned to the bottom. Page context (url/title/selection/text) is attached
 * to every turn; the server wraps it as untrusted external content.
 */
import { normalizePageKey, renderMarkdownLite, type HistoryMessage, type PortEvent } from "./shared.js";

const STRINGS = {
  ru: {
    pill: "claw2",
    notConfigured: "Расширение не настроено — откройте настройки и укажите адрес шлюза и ключ.",
    placeholder: "Спросить о странице…",
    send: "Отправить",
    stop: "Стоп",
    close: "Свернуть",
    pageTitle: "Страница",
    continueChat: "Продолжаем чат этой вкладки",
    aboutSelection: "Про выделенное",
    empty: "Задайте вопрос — claw2 увидит текст страницы.",
    connectionLost: "Соединение с шлюзом потеряно.",
  },
  en: {
    pill: "claw2",
    notConfigured: "The extension is not configured — open the options and set the gateway URL and key.",
    placeholder: "Ask about this page…",
    send: "Send",
    stop: "Stop",
    close: "Collapse",
    pageTitle: "Page",
    continueChat: "Continuing this tab's chat",
    aboutSelection: "About the selection",
    empty: "Ask a question — claw2 will see the page text.",
    connectionLost: "Lost connection to the gateway.",
  },
} as const;

const t = navigator.language.toLowerCase().startsWith("ru") ? STRINGS.ru : STRINGS.en;

function h<T extends HTMLElement>(tag: string, attrs: Record<string, string> = {}): T {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el as T;
}

function pageText(limit: number): string {
  const raw = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
  return raw.slice(0, limit);
}

function collectContext(): { url: string; title: string; snippet: string; text: string; pageKey: string | null } {
  const selection = (window.getSelection?.()?.toString() ?? "").trim();
  return {
    url: location.href,
    title: (document.title || location.hostname).trim(),
    snippet: selection || pageText(700),
    text: selection,
    pageKey: normalizePageKey(location.href),
  };
}

async function sendBackground<T>(message: unknown): Promise<T> {
  return (await chrome.runtime.sendMessage(message)) as T;
}

function mount(): void {
  if (document.getElementById("claw2-companion-host")) return;
  const host = h<HTMLDivElement>("div", { id: "claw2-companion-host" });
  const shadow = host.attachShadow({ mode: "closed" });

  const style = h<HTMLStyleElement>("style");
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    .pill {
      position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
      padding: 9px 14px; border-radius: 999px; border: 1px solid rgba(255,255,255,.18);
      background: rgba(26,26,30,.92); color: #fff; font-size: 13px; font-weight: 600;
      cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.35); user-select: none;
    }
    .pill:hover { background: #2a2a30; }
    .panel {
      position: fixed; right: 14px; top: 14px; bottom: 14px; width: 400px; z-index: 2147483647;
      display: flex; flex-direction: column; border-radius: 16px; overflow: hidden;
      border: 1px solid rgba(255,255,255,.14); background: rgba(24,24,28,.96);
      color: #ececf1; box-shadow: 0 12px 40px rgba(0,0,0,.5);
    }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,.1); }
    .head .title { flex: 1; font-size: 12px; color: #b6b6c0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .head button { border: none; background: transparent; color: #b6b6c0; font-size: 16px; cursor: pointer; }
    .feed { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .msg { max-width: 92%; padding: 8px 11px; border-radius: 12px; font-size: 13.5px; line-height: 1.45; word-wrap: break-word; }
    .msg.user { align-self: flex-end; background: #7b66ff; color: #fff; white-space: pre-wrap; }
    .msg.assistant { align-self: flex-start; background: #2a2a31; }
    .msg.assistant a { color: #a99bff; }
    .msg.assistant code { background: #1c1c21; padding: 1px 4px; border-radius: 4px; font-size: 12.5px; }
    .msg.assistant pre { background: #1c1c21; padding: 8px; border-radius: 8px; overflow-x: auto; margin: 6px 0; }
    .msg.assistant pre code { background: transparent; padding: 0; }
    .hint { align-self: center; font-size: 11px; color: #77777f; }
    .composer { display: flex; gap: 8px; padding: 10px; border-top: 1px solid rgba(255,255,255,.1); }
    .composer textarea {
      flex: 1; resize: none; max-height: 120px; padding: 9px 11px; border-radius: 12px;
      border: 1px solid rgba(255,255,255,.16); background: #1c1c21; color: #ececf1; font-size: 13.5px; line-height: 1.4;
    }
    .composer button {
      align-self: flex-end; padding: 9px 13px; border-radius: 12px; border: none;
      background: #7b66ff; color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .composer button:disabled { opacity: .5; cursor: default; }
    .err { color: #ff9b9b; }
  `;
  shadow.appendChild(style);

  const pill = h<HTMLButtonElement>("button", { class: "pill", title: t.pill });
  pill.textContent = t.pill;
  shadow.appendChild(pill);

  const panel = h<HTMLDivElement>("div", { class: "panel", style: "display:none" });
  const head = h<HTMLDivElement>("div", { class: "head" });
  const headTitle = h<HTMLSpanElement>("span", { class: "title" });
  const closeBtn = h<HTMLButtonElement>("button", { title: t.close });
  closeBtn.textContent = "×";
  head.append(headTitle, closeBtn);

  const feed = h<HTMLDivElement>("div", { class: "feed" });
  const composer = h<HTMLDivElement>("div", { class: "composer" });
  const input = h<HTMLTextAreaElement>("textarea", { rows: "1", placeholder: t.placeholder });
  const sendBtn = h<HTMLButtonElement>("button");
  sendBtn.textContent = t.send;
  composer.append(input, sendBtn);
  panel.append(head, feed, composer);

  pill.addEventListener("click", () => {
    panel.style.display = panel.style.display === "none" ? "flex" : "none";
    if (panel.style.display !== "none") input.focus();
  });
  closeBtn.addEventListener("click", () => {
    panel.style.display = "none";
  });
  shadow.appendChild(panel);

  let configured = false;
  let sessionId: string | undefined;
  let busy = false;
  let abortPort: chrome.runtime.Port | null = null;

  function addMsg(role: "user" | "assistant" | "hint" | "err", html: string): HTMLDivElement {
    const msg = h<HTMLDivElement>("div", { class: `msg ${role === "hint" || role === "err" ? "assistant" : role}` });
    if (role === "hint") {
      msg.className = "hint";
      msg.textContent = html;
    } else if (role === "err") {
      msg.className = "hint err";
      msg.textContent = html;
    } else if (role === "user") {
      msg.textContent = html;
    } else {
      msg.innerHTML = html;
    }
    feed.appendChild(msg);
    feed.scrollTop = feed.scrollHeight;
    return msg;
  }

  function setBusy(on: boolean): void {
    busy = on;
    sendBtn.textContent = on ? t.stop : t.send;
    input.disabled = on;
  }

  function startChat(text: string): void {
    if (busy) {
      abortPort?.disconnect();
      abortPort = null;
      setBusy(false);
      return;
    }
    const question = text.trim();
    if (!question) return;
    input.value = "";
    addMsg("user", question);
    const ctx = collectContext();
    const streaming = addMsg("assistant", "…");

    const port = chrome.runtime.connect({ name: "claw2-chat" });
    abortPort = port;
    let full = "";
    port.onMessage.addListener((raw) => {
      const ev = raw as PortEvent;
      if (ev.type === "chunk") {
        full += ev.content;
        streaming.innerHTML = renderMarkdownLite(full);
        feed.scrollTop = feed.scrollHeight;
      } else if (ev.type === "openBrowserUrl") {
        // The overlay lives in the page: navigating this tab keeps the chat
        // (the session is remembered per tab and history reloads).
        window.location.assign(ev.url);
      } else if (ev.type === "done") {
        if (ev.sessionId) sessionId = ev.sessionId;
        if (ev.content && ev.content.trim() && ev.content.trim() !== full.trim()) {
          streaming.innerHTML = renderMarkdownLite(ev.content);
        }
        if (!full && !ev.content) streaming.remove();
        finish();
      } else if (ev.type === "error") {
        streaming.remove();
        addMsg("err", ev.error);
        finish();
      }
    });
    port.onDisconnect.addListener(() => {
      if (busy) {
        addMsg("err", t.connectionLost);
        finish();
      }
    });
    setBusy(true);
    port.postMessage({
      type: "chat",
      sessionId,
      message: question,
      pageContext: { url: ctx.url, title: ctx.title, snippet: ctx.snippet.slice(0, 700), text: ctx.text || undefined },
      browserPageText: pageText(16000),
      browserPageKey: ctx.pageKey ?? undefined,
      chatTitle: ctx.title,
    });

    function finish(): void {
      abortPort = null;
      setBusy(false);
      input.focus();
    }
  }

  sendBtn.addEventListener("click", () => startChat(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      startChat(input.value);
    }
  });

  // The page's own key handlers must not leak into the overlay.
  panel.addEventListener("keydown", (e) => e.stopPropagation());

  // Selection ask: from the context menu (via the background).
  chrome.runtime.onMessage.addListener((raw) => {
    const msg = raw as { type?: string; text?: string };
    if (msg?.type === "ask-selection" && typeof msg.text === "string") {
      panel.style.display = "flex";
      input.value = `${t.aboutSelection}: «${msg.text.slice(0, 400)}»\n\n`;
      input.focus();
    }
  });

  // Boot: config check + session restore.
  void (async () => {
    const cfg = await sendBackground<{ ok: boolean }>({ type: "getConfig" });
    configured = cfg?.ok === true;
    headTitle.textContent = `${t.pageTitle}: ${collectContext().title}`;
    if (!configured) {
      addMsg("hint", t.notConfigured);
      pill.addEventListener("click", () => {
        if (!configured) void sendBackground({ type: "openOptions" });
      }, { once: true });
      return;
    }
    const s = await sendBackground<{ sessionId?: string }>({ type: "getSession" });
    sessionId = s?.sessionId;
    if (sessionId) {
      const hist = await sendBackground<{ messages: HistoryMessage[] }>({ type: "history", sessionId });
      const messages = hist?.messages ?? [];
      if (messages.length > 0) {
        addMsg("hint", t.continueChat);
        for (const m of messages.slice(-10)) {
          if (m.role === "user") addMsg("user", m.content ?? "");
          else addMsg("assistant", renderMarkdownLite(m.content ?? ""));
        }
      } else {
        addMsg("hint", t.empty);
      }
    } else {
      addMsg("hint", t.empty);
    }
  })();

  document.documentElement.appendChild(host);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount, { once: true });
} else {
  mount();
}
