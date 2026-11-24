// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * claw2 companion — background service worker. The ONLY owner of the network
 * (content-script fetches are subject to the page's CSP; the worker is not,
 * and host_permissions bypass CORS). Streams /chat SSE back to the overlay
 * over a long-lived port. Chat sessions are remembered per tab so navigation
 * continues the same conversation.
 */
import type { CompanionConfig, HistoryMessage, PortEvent, PortMessage } from "./shared.js";

const MENU_ID = "claw2-ask-selection";

async function getConfig(): Promise<CompanionConfig | null> {
  const stored = await chrome.storage.local.get(["gatewayUrl", "apiKey"]);
  const gatewayUrl = String(stored.gatewayUrl ?? "").replace(/\/+$/, "");
  const apiKey = String(stored.apiKey ?? "").trim();
  if (!gatewayUrl || !apiKey) return null;
  return { gatewayUrl, apiKey };
}

function authHeaders(config: CompanionConfig): Record<string, string> {
  return { "Content-Type": "application/json", "X-API-Key": config.apiKey };
}

/** tabId → sessionId: the overlay survives page navigation in the same tab. */
async function getSessionId(tabId: number): Promise<string | undefined> {
  const stored = await chrome.storage.session.get([`tab-${tabId}`]);
  const v = stored[`tab-${tabId}`];
  return typeof v === "string" ? v : undefined;
}

async function setSessionId(tabId: number, sessionId: string): Promise<void> {
  await chrome.storage.session.set({ [`tab-${tabId}`]: sessionId });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Ask claw2 about "%s"',
      contexts: ["selection"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  void chrome.tabs.sendMessage(tab.id, { type: "ask-selection", text: info.selectionText ?? "" });
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

/** Simple request/response for non-streaming calls from the content script. */
chrome.runtime.onMessage.addListener((raw, sender) => {
  const msg = raw as { type?: string; sessionId?: string; [k: string]: unknown };
  if (!msg || typeof msg !== "object") return undefined;
  if (msg.type === "getConfig") {
    return getConfig().then((c) => ({ ok: !!c }));
  }
  if (msg.type === "openOptions") {
    chrome.runtime.openOptionsPage();
    return Promise.resolve({ ok: true });
  }
  if (msg.type === "getSession") {
    const tabId = sender.tab?.id;
    if (tabId == null) return Promise.resolve({ sessionId: undefined });
    return getSessionId(tabId).then((sessionId) => ({ sessionId }));
  }
  if (msg.type === "history") {
    const sessionId = String(msg.sessionId ?? "");
    return (async () => {
      const config = await getConfig();
      if (!config || !sessionId) return { messages: [] as HistoryMessage[] };
      const res = await fetch(
        `${config.gatewayUrl}/chat/history?session_id=${encodeURIComponent(sessionId)}`,
        { headers: authHeaders(config) },
      );
      if (!res.ok) return { messages: [] as HistoryMessage[] };
      const data = (await res.json()) as { messages?: HistoryMessage[] };
      return { messages: (data.messages ?? []).filter((m) => m.role === "user" || m.role === "assistant") };
    })();
  }
  return undefined;
});

/** Streaming chat over a port (a port keeps the service worker alive). */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "claw2-chat") return;
  const abort = new AbortController();
  let sessionId: string | undefined;
  // Dropping the port only detaches this client: the turn runs on the gateway
  // until it is told to stop.
  port.onDisconnect.addListener(() => abort.abort());

  /** Explicit stop: ask the gateway to cancel the turn (it keeps what it had done). */
  const cancelRun = () => {
    const sid = sessionId;
    if (!sid) return;
    void getConfig()
      .then((config) =>
        config
          ? fetch(`${config.gatewayUrl}/chat/cancel`, {
              method: "POST",
              headers: authHeaders(config),
              body: JSON.stringify({ sessionId: sid }),
              keepalive: true,
            }).catch(() => {})
          : null
      )
      .catch(() => {});
  };

  port.onMessage.addListener((raw) => {
    const msg = raw as PortMessage;
    if (msg?.type === "abort") {
      cancelRun();
      abort.abort();
      return;
    }
    if (msg?.type !== "chat") return;
    void (async () => {
      const config = await getConfig();
      if (!config) {
        port.postMessage({ type: "error", error: "Not configured: open the extension options" } satisfies PortEvent);
        return;
      }
      const senderTabId = (port.sender as { tab?: { id?: number } } | undefined)?.tab?.id;
      sessionId = msg.sessionId ?? (senderTabId != null ? await getSessionId(senderTabId) : undefined);
      let lastEvent: PortEvent = { type: "done" };
      try {
        const res = await fetch(`${config.gatewayUrl}/chat`, {
          method: "POST",
          headers: authHeaders(config),
          signal: abort.signal,
          body: JSON.stringify({
            message: msg.message,
            sessionId,
            stream: true,
            pageContext: msg.pageContext,
            browserPageText: msg.browserPageText,
            browserPageKey: msg.browserPageKey,
            chatTitle: msg.chatTitle,
          }),
        });
        if (!res.ok || !res.body) {
          const errText = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status} ${errText.slice(0, 200)}`);
        }
        // SSE parse: blank-line separated events, "data: {...}" lines.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) >= 0) {
            const rawEvent = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            for (const line of rawEvent.split("\n")) {
              if (!line.startsWith("data:")) continue;
              try {
                const data = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
                if (typeof data.content === "string") {
                  port.postMessage({ type: "chunk", content: data.content } satisfies PortEvent);
                } else if (typeof data.url === "string" && "openBrowserUrl" in data) {
                  port.postMessage({ type: "openBrowserUrl", url: data.url } satisfies PortEvent);
                } else if (data.done === true || "sessionId" in data) {
                  const sid = typeof data.sessionId === "string" ? data.sessionId : undefined;
                  if (sid && senderTabId != null) await setSessionId(senderTabId, sid);
                  lastEvent = {
                    type: "done",
                    sessionId: sid,
                    content: typeof data.content === "string" ? data.content : undefined,
                    error: typeof data.error === "string" ? data.error : undefined,
                  };
                }
              } catch {
                /* keep-alive comment or partial line */
              }
            }
          }
        }
        port.postMessage(lastEvent satisfies PortEvent);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("abort") || message.includes("Abort")) {
          port.postMessage({ type: "done" } satisfies PortEvent);
        } else {
          port.postMessage({ type: "error", error: message } satisfies PortEvent);
        }
      }
    })();
  });
});
