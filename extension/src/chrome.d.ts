// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Minimal chrome.* typing for the APIs this extension uses — no @types/chrome
 * dependency, nothing else is allowed through.
 */

declare namespace chrome {
  namespace runtime {
    interface Port {
      name: string;
      postMessage(message: unknown): void;
      disconnect(): void;
      readonly sender: MessageSender | undefined;
      onMessage: {
        addListener(cb: (message: unknown, port: Port) => void): void;
      };
      onDisconnect: {
        addListener(cb: (port: Port) => void): void;
      };
    }
    interface MessageSender {
      tab?: { id?: number };
    }
    function sendMessage(message: unknown): Promise<unknown>;
    function connect(name?: string): Port;
    const onMessage: {
      addListener(cb: (message: unknown, sender: MessageSender) => void | Promise<unknown>): void;
    };
    const onConnect: {
      addListener(cb: (port: Port) => void): void;
    };
    function openOptionsPage(): void;
    const onInstalled: {
      addListener(cb: (details: { reason?: string }) => void): void;
    };
    function getURL(path: string): string;
    const lastError: { message?: string } | undefined;
  }

  namespace storage {
    interface StorageArea {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    }
    const local: StorageArea;
    const session: StorageArea;
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
    }
    function query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
    function update(tabId: number, updateProperties: { url?: string; active?: boolean }): Promise<Tab>;
    function sendMessage(tabId: number, message: unknown): Promise<unknown>;
  }

  namespace contextMenus {
    interface CreateProperties {
      id?: string;
      title: string;
      contexts: Array<"selection" | "page" | "all">;
    }
    function create(properties: CreateProperties): number | string | undefined;
    function removeAll(callback?: () => void): void;
    const onClicked: {
      addListener(cb: (info: { menuItemId: number | string; selectionText?: string }, tab?: Tab) => void): void;
    };
  }

  namespace action {
    const onClicked: {
      addListener(cb: (tab: Tab) => void): void;
    };
  }
}
