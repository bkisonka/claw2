import { normalizePageKey, pageKeyLabel } from "./pageKey";

export type TabChatBinding = {
  tabId: string;
  /** Always the shared current chat — tabs do not own sessions. */
  sessionId: string;
  pageKey?: string;
  pageTitle?: string;
  /** When true, next user turn should prepend a visit marker (time + site title). */
  pendingVisitMarker?: boolean;
};

/** @deprecated Kept for pruning leftover localStorage from v1 pageKey chats. */
export type PageKeyIndex = Record<string, string>;

const PAGE_KEY_STORAGE = "claw2.browser.pageKeySessions";

export function loadPageKeyIndex(): PageKeyIndex {
  try {
    const raw =
      localStorage.getItem(PAGE_KEY_STORAGE) ?? sessionStorage.getItem(PAGE_KEY_STORAGE);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: PageKeyIndex = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function savePageKeyIndex(index: PageKeyIndex): void {
  try {
    localStorage.setItem(PAGE_KEY_STORAGE, JSON.stringify(index));
    try {
      sessionStorage.removeItem(PAGE_KEY_STORAGE);
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
}

export function newSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `sess_${crypto.randomUUID()}`;
  }
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Resolve tab page meta after navigation.
 * Session is always `sharedSessionId` (current chat) — never minted from pageKey.
 */
export function resolveTabSession(opts: {
  tabId: string;
  url: string;
  title?: string;
  prev?: TabChatBinding | null;
  /** Unified chat id for C + W + all tabs. */
  sharedSessionId: string;
  /** Ignored for session resolution (v1 leftover). */
  pageKeyIndex?: PageKeyIndex;
}): {
  binding: TabChatBinding;
  pageKeyIndex: PageKeyIndex;
  /** True if pageKey changed to a real page (caller may set visit marker). */
  pageChanged: boolean;
  /** @deprecated alias — always false for “reuse other page chat”. */
  reusedPageChat: boolean;
} {
  const pageKey = normalizePageKey(opts.url);
  const title = (opts.title || "").trim();
  const prev = opts.prev ?? null;
  const sessionId = opts.sharedSessionId || prev?.sessionId || newSessionId();
  const index = { ...(opts.pageKeyIndex ?? {}) };

  if (!pageKey) {
    // Transient blank during load — keep prior page meta so Chat does not remount.
    if (prev?.sessionId) {
      return {
        binding: { ...prev, sessionId, pendingVisitMarker: false },
        pageKeyIndex: index,
        pageChanged: false,
        reusedPageChat: false,
      };
    }
    return {
      binding: {
        tabId: opts.tabId,
        sessionId,
        pageKey: undefined,
        pageTitle: undefined,
        pendingVisitMarker: false,
      },
      pageKeyIndex: index,
      pageChanged: false,
      reusedPageChat: false,
    };
  }

  const pageChanged = prev?.pageKey !== pageKey;
  return {
    binding: {
      tabId: opts.tabId,
      sessionId,
      pageKey,
      pageTitle: title || (pageChanged ? pageKeyLabel(pageKey) : prev?.pageTitle) || pageKeyLabel(pageKey),
      pendingVisitMarker: pageChanged,
    },
    pageKeyIndex: index,
    pageChanged,
    reusedPageChat: false,
  };
}

/** @deprecated v1 index — no longer used to pick session. */
export function registerPageKeySession(index: PageKeyIndex, pageKey: string, sessionId: string): PageKeyIndex {
  if (!pageKey || !sessionId) return index;
  if (index[pageKey] === sessionId) return index;
  return { ...index, [pageKey]: sessionId };
}

export function prunePageKeyIndex(index: PageKeyIndex, keepSessionIds: Set<string>): PageKeyIndex {
  let changed = false;
  const out: PageKeyIndex = {};
  for (const [k, sid] of Object.entries(index)) {
    if (keepSessionIds.has(sid)) out[k] = sid;
    else changed = true;
  }
  return changed ? out : index;
}

export { normalizePageKey, pageKeyLabel };
