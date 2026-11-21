// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Pending map for live read_browser_page: SSE request → client POST response.
 */
import { AbortError, throwIfAborted } from "../core/abort.js";

export type BrowserPageTextPayload = {
  url?: string;
  title?: string;
  text: string;
  truncated?: boolean;
};

type Pending = {
  resolve: (value: BrowserPageTextPayload | null) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
};

const pending = new Map<string, Pending>();

export function waitForBrowserPageText(
  requestId: string,
  timeoutMs = 10_000,
  signal?: AbortSignal
): Promise<BrowserPageTextPayload | null> {
  const id = String(requestId || "").trim();
  if (!id) return Promise.resolve(null);
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const prev = pending.get(id);
    if (prev) {
      clearTimeout(prev.timer);
      if (prev.signal && prev.onAbort) prev.signal.removeEventListener("abort", prev.onAbort);
      prev.resolve(null);
    }
    const cleanup = () => {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      if (pending.get(id)?.timer === timer) pending.delete(id);
    };
    const onAbort = signal
      ? () => {
          cleanup();
          reject(new AbortError());
        }
      : undefined;
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, Math.max(1_000, timeoutMs));
    if (signal && onAbort) signal.addEventListener("abort", onAbort, { once: true });
    pending.set(id, { resolve, timer, signal, onAbort });
  });
}

export function resolveBrowserPageText(
  requestId: string,
  payload: BrowserPageTextPayload | null
): boolean {
  const id = String(requestId || "").trim();
  const entry = pending.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  if (entry.signal && entry.onAbort) {
    entry.signal.removeEventListener("abort", entry.onAbort);
  }
  pending.delete(id);
  entry.resolve(payload);
  return true;
}
