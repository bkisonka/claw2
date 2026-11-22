// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation, Navigate, useNavigate } from "react-router-dom";
import { Layout } from "../components/Layout";
import { BrowserSurface } from "../components/BrowserSurface";
import { ChatPage } from "./ChatPage";
import { CabinetPage } from "./CabinetPage";
import { GalleryPage } from "./GalleryPage";
import { DocumentsPage } from "./DocumentsPage";
import { CallsPage } from "./CallsPage";
import { ChatPageProvider } from "../context/ChatPageContext";
import { useAuth } from "../context/AuthContext";
import type { Message } from "../components/Chat";
import type { BrowserAskSelection } from "../desktop";
import {
  fetchChatList,
  fetchChatHistory,
  fetchSearchResults,
  deleteChat,
  duplicateChat,
  updateChatProject,
  updateChatBrowserPageKey,
  updateChatPinned,
  updateChatFavorited,
  touchChat,
  exportChatClawCache,
  renameChat,
} from "../api/chat";
import { browserSearch } from "../api/browserSearch";
import { getConfig } from "../api/config";
import { fetchProjectList, deleteProject, type ProjectListItemApi } from "../api/project";
import { type ChatItem, compareChatItems, resolveListTitle } from "../store/chatList";
import {
  evictChatHistories,
  selectInactiveHistoryEvictions,
} from "../store/chatHistoryLru";
import type { ChatPageOutletContext } from "./ChatPage";
import { useI18n } from "../i18n";
import { stripImageFromMessages } from "../lib/galleryActions";
import { LlmSetupScreen } from "../components/LlmSetupScreen";
import { fetchConnectionsStatus } from "../api/connections";
import {
  loadPageKeyIndex,
  savePageKeyIndex,
  resolveTabSession,
  registerPageKeySession,
  prunePageKeyIndex,
  newSessionId,
  pageKeyLabel,
  type TabChatBinding,
} from "../browser/tabChatBindings";
import {
  mergeHistoryWithVisitMarkers,
  persistVisitMarkersFromMessages,
  clearVisitMarkers,
} from "../browser/visitMarkers";
import { releaseChatTranscriptBlobPreviewUrls } from "../lib/transcriptBlobUrls";

const SEARCH_DEBOUNCE_MS = 300;
const MAIN_SURFACE_KEY = "claw2.mainSurface";

type MainSurface = "chat" | "web";

function readMainSurface(): MainSurface {
  try {
    const v = sessionStorage.getItem(MAIN_SURFACE_KEY);
    return v === "web" ? "web" : "chat";
  } catch {
    return "chat";
  }
}

function writeMainSurface(v: MainSurface) {
  try {
    sessionStorage.setItem(MAIN_SURFACE_KEY, v);
  } catch {
    /* ignore */
  }
}

/** Stable chat id for a blank composer — avoids shared sidebar key "anon". */
function newProvisionalSessionId(): string {
  return newSessionId();
}

export function AuthenticatedArea() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, authMode, checked } = useAuth();
  const { locale, t } = useI18n();
  const [chats, setChats] = useState<ChatItem[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(() => newProvisionalSessionId());
  const [searchQuery, setSearchQuery] = useState("");
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<Awaited<ReturnType<typeof fetchSearchResults>>>([]);
  const [searchResultsLoading, setSearchResultsLoading] = useState(false);
  const [searchResultsError, setSearchResultsError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectListItemApi[]>([]);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [seedPrompt, setSeedPrompt] = useState<string | null>(null);
  const [seedPageContext, setSeedPageContext] = useState<BrowserAskSelection | null>(null);
  const [mainSurface, setMainSurface] = useState<MainSurface>(() => readMainSurface());
  const [webAnswerOverlay, setWebAnswerOverlay] = useState<{
    messages: {
      role: "user" | "assistant" | "visit_marker";
      content: string;
      at?: string;
      cells?: { type: string; content: string }[];
    }[];
    streaming: boolean;
  } | null>(null);
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);
  const [chatEpoch, setChatEpoch] = useState(0);
  const [removedImageUrls, setRemovedImageUrls] = useState<string[]>([]);
  const [needsLlmSetup, setNeedsLlmSetup] = useState<boolean | null>(null);
  const [pendingVisitMarker, setPendingVisitMarker] = useState(false);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTabIdRef = useRef<string | null>(null);
  const tabBindingsRef = useRef<Map<string, TabChatBinding>>(new Map());
  const pageKeyIndexRef = useRef(loadPageKeyIndex());
  const streamingSessionsRef = useRef(new Set<string>());
  const [streamingChatIds, setStreamingChatIds] = useState<string[]>([]);
  const [historyLoadingChatIds, setHistoryLoadingChatIds] = useState<string[]>([]);
  const [attentionChatIds, setAttentionChatIds] = useState<string[]>([]);
  /** AbortControllers for in-flight chats — survive Chat remount on switch. */
  const streamAbortRef = useRef(new Map<string, AbortController>());
  const historyLoadPromisesRef = useRef(new Map<string, Promise<void>>());
  const historyLastAccessedRef = useRef(new Map<string, number>());
  const mainSurfaceRef = useRef(mainSurface);
  mainSurfaceRef.current = mainSurface;
  const currentChatIdRef = useRef(currentChatId);
  currentChatIdRef.current = currentChatId;
  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  /** Session we intentionally want overlay for (sidebar select / reopen) — survives createTab race. */
  const overlayIntentRef = useRef<string | null>(null);
  /** User closed the answer overlay for this session — do not auto-reopen on SPA/in-page URL churn. */
  const overlayDismissedSessionRef = useRef<string | null>(null);
  const [activeBrowserMeta, setActiveBrowserMeta] = useState<{
    title: string | null;
    pageKey: string | null;
  }>({ title: null, pageKey: null });

  const persistPageKeyBinding = useCallback((pageKey: string, sessionId: string) => {
    if (!pageKey || !sessionId) return;
    const nextIndex = registerPageKeySession(pageKeyIndexRef.current, pageKey, sessionId);
    if (nextIndex !== pageKeyIndexRef.current) {
      pageKeyIndexRef.current = nextIndex;
      savePageKeyIndex(nextIndex);
    }
    void updateChatBrowserPageKey(sessionId, pageKey).catch(() => {});
  }, []);

  /** Soft meta on existing chat only — never rename the whole chat to every surfed page title. */
  const touchBrowserChatInList = useCallback((binding: TabChatBinding) => {
    if (!binding.pageKey) return;
    setChats((prev) => {
      const idx = prev.findIndex((c) => c.id === binding.sessionId);
      if (idx < 0) return prev;
      const cur = prev[idx]!;
      if (cur.browserPageKey === binding.pageKey) return prev;
      const copy = [...prev];
      copy[idx] = {
        ...cur,
        browserPageKey: binding.pageKey,
        updatedAt: Date.now(),
      };
      return copy;
    });
    void updateChatBrowserPageKey(binding.sessionId, binding.pageKey).catch(() => {});
  }, []);

  const toOverlayMessages = useCallback((msgs: Message[]) => {
    return msgs
      .filter(
        (m): m is Message & { role: "user" | "assistant" | "visit_marker" } =>
          m.role === "user" || m.role === "assistant" || m.role === "visit_marker"
      )
      .map((m) =>
        m.role === "visit_marker"
          ? { role: "visit_marker" as const, content: m.content, at: m.at ?? m.content }
          : {
              role: m.role as "user" | "assistant",
              content: m.content,
              ...(m.cells?.length ? { cells: m.cells } : {}),
            }
      );
  }, []);

  // applyHistory is declared later — hold a stable ref for showOverlayForSession
  const applyHistoryRef = useRef<((chatId: string, messages: Message[]) => void) | null>(null);

  const showOverlayForSession = useCallback(
    async (sessionId: string) => {
      if (!sessionId) {
        setWebAnswerOverlay(null);
        return;
      }
      overlayIntentRef.current = sessionId;
      overlayDismissedSessionRef.current = null;
      let msgs = chatsRef.current.find((c) => c.id === sessionId)?.messages ?? [];
      if (msgs.length === 0) {
        try {
          const loaded = (await fetchChatHistory(sessionId)) as Message[];
          applyHistoryRef.current?.(sessionId, loaded);
          // Sync ref immediately — activateTabBinding may race before setState flushes.
          const existing = chatsRef.current.find((c) => c.id === sessionId);
          if (existing) {
            chatsRef.current = chatsRef.current.map((c) =>
              c.id === sessionId ? { ...c, messages: loaded, historyEvicted: false } : c
            );
          } else if (loaded.length > 0) {
            chatsRef.current = [
              {
                id: sessionId,
                title: pageKeyLabel(
                  Object.entries(pageKeyIndexRef.current).find(([, sid]) => sid === sessionId)?.[0] ??
                    sessionId
                ),
                updatedAt: Date.now(),
                messages: loaded,
              },
              ...chatsRef.current,
            ];
          }
          msgs = loaded;
        } catch {
          /* ignore */
        }
      }
      const stillWanted =
        overlayIntentRef.current === sessionId ||
        currentChatIdRef.current === sessionId ||
        (!!activeTabIdRef.current &&
          tabBindingsRef.current.get(activeTabIdRef.current)?.sessionId === sessionId);
      if (!stillWanted) return;
      if (msgs.length === 0) {
        setWebAnswerOverlay(null);
        return;
      }
      setWebAnswerOverlay({
        messages: toOverlayMessages(msgs),
        streaming: streamingSessionsRef.current.has(sessionId),
      });
    },
    [toOverlayMessages]
  );

  const siteLabelForBinding = useCallback((binding: TabChatBinding) => {
    return (
      (binding.pageTitle || "").trim() ||
      (binding.pageKey ? pageKeyLabel(binding.pageKey) : "") ||
      ""
    );
  }, []);

  const appendVisitMarkerIfNeeded = useCallback(
    (binding: TabChatBinding) => {
      if (!binding.pendingVisitMarker) return binding;
      const site = siteLabelForBinding(binding);
      let appended = false;
      setChats((prev) =>
        prev.map((c) => {
          if (c.id !== binding.sessionId) return c;
          if (!c.messages.length) return c;
          const last = c.messages[c.messages.length - 1];
          if (last?.role === "visit_marker") return c;
          const at = new Date().toISOString();
          appended = true;
          const messages = [
            ...c.messages,
            { role: "visit_marker" as const, content: site || at, at },
          ];
          persistVisitMarkersFromMessages(binding.sessionId, messages);
          return {
            ...c,
            updatedAt: Date.now(),
            messages,
          };
        })
      );
      if (appended) {
        return { ...binding, pendingVisitMarker: false };
      }
      return binding;
    },
    [siteLabelForBinding]
  );

  /** Sync tab meta into the unified current chat — never mint/switch CHATID from tabs. */
  const activateTabBinding = useCallback(
    (
      binding: TabChatBinding,
      opts?: {
        closeOverlay?: boolean;
        showOverlay?: boolean;
      }
    ) => {
      const sharedId = currentChatIdRef.current || binding.sessionId;
      const aligned = { ...binding, sessionId: sharedId };
      const next = appendVisitMarkerIfNeeded(aligned);
      tabBindingsRef.current.set(next.tabId, next);
      touchBrowserChatInList(next);
      setActiveBrowserMeta({
        title: (next.pageTitle || "").trim() || null,
        pageKey: next.pageKey ?? null,
      });
      setPendingVisitMarker(!!next.pendingVisitMarker);
      if (opts?.showOverlay) {
        overlayDismissedSessionRef.current = null;
        void showOverlayForSession(sharedId);
      } else if (opts?.closeOverlay) {
        setWebAnswerOverlay(null);
      }
    },
    [appendVisitMarkerIfNeeded, touchBrowserChatInList, showOverlayForSession]
  );

  const handleStreamingChange = useCallback((sessionId: string, streaming: boolean) => {
    if (!sessionId) return;
    if (streaming) {
      streamingSessionsRef.current.add(sessionId);
      historyLastAccessedRef.current.set(sessionId, Date.now());
    } else streamingSessionsRef.current.delete(sessionId);
    setStreamingChatIds(Array.from(streamingSessionsRef.current));
  }, []);

  const handleRegisterStreamAbort = useCallback(
    (sessionId: string, controller: AbortController | null) => {
      if (!sessionId) return;
      const prev = streamAbortRef.current.get(sessionId);
      if (controller) {
        if (prev && prev !== controller) {
          try {
            prev.abort();
          } catch {
            /* ignore */
          }
        }
        streamAbortRef.current.set(sessionId, controller);
      } else if (prev) {
        streamAbortRef.current.delete(sessionId);
      }
    },
    []
  );

  const handleAbortSession = useCallback((sessionId: string) => {
    if (!sessionId) return;
    const ac = streamAbortRef.current.get(sessionId);
    if (!ac) return;
    try {
      ac.abort();
    } catch {
      /* ignore */
    }
    streamAbortRef.current.delete(sessionId);
  }, []);

  /** Live transcript while streaming (keeps sidebar + re-opened chat in sync). */
  const handleStreamProgress = useCallback(
    (sessionId: string, title: string, messages: Message[]) => {
      if (!sessionId || !messages.length) return;
      setChats((prev) => {
        const copy = [...prev];
        const idx = copy.findIndex((c) => c.id === sessionId);
        const existing = idx >= 0 ? copy[idx] : undefined;
        const listTitle = resolveListTitle(existing?.title, title);
        const item: ChatItem = {
          id: sessionId,
          title: listTitle,
          updatedAt: Date.now(),
          messages,
          projectId: pendingProjectId ?? existing?.projectId ?? undefined,
          browserPageKey: existing?.browserPageKey ?? null,
          model: existing?.model ?? null,
          pinned: existing?.pinned,
          favorited: existing?.favorited,
          titleManual: existing?.titleManual,
          hasImages: existing?.hasImages,
          hasDocs: existing?.hasDocs,
          historyEvicted: false,
        };
        if (idx >= 0) copy[idx] = item;
        else copy.unshift(item);
        return copy.sort(compareChatItems);
      });
    },
    [pendingProjectId]
  );

  const handleChatModelChange = useCallback((sessionId: string, model: string | null) => {
    const id = sessionId.trim();
    if (!id) return;
    setChats((prev) => {
      const idx = prev.findIndex((c) => c.id === id);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = { ...copy[idx]!, model, updatedAt: Date.now() };
        return copy.sort(compareChatItems);
      }
      // New chat: create a list row so the override survives remounts before first message.
      return [
        {
          id,
          title: t("chat.listNewChat"),
          updatedAt: Date.now(),
          messages: [],
          model,
          projectId: pendingProjectId ?? undefined,
        },
        ...prev,
      ];
    });
  }, [pendingProjectId, t]);

  /** Finished while user is viewing another chat → sidebar alert. */
  const handleStreamComplete = useCallback((sessionId: string, info?: { aborted?: boolean }) => {
    if (!sessionId || info?.aborted) return;
    if (currentChatIdRef.current === sessionId) return;
    setAttentionChatIds((prev) => (prev.includes(sessionId) ? prev : [...prev, sessionId]));
  }, []);

  const handleBrowserActiveTabChange = useCallback(
    (tabId: string | null) => {
      const prevTabId = activeTabIdRef.current;
      const tabChanged = prevTabId !== tabId;
      activeTabIdRef.current = tabId;
      if (!tabId) return;
      const sharedId = currentChatIdRef.current || newSessionId();
      let binding = tabBindingsRef.current.get(tabId);
      if (!binding) {
        binding = { tabId, sessionId: sharedId, pendingVisitMarker: false };
        tabBindingsRef.current.set(tabId, binding);
      } else if (binding.sessionId !== sharedId) {
        binding = { ...binding, sessionId: sharedId };
        tabBindingsRef.current.set(tabId, binding);
      }
      if (!tabChanged) return;
      // Same CHATID on every tab — only refresh page meta; leave overlay as the user left it.
      activateTabBinding(binding);
    },
    [activateTabBinding]
  );

  const handleBrowserTabClosed = useCallback((tabId: string) => {
    // Closing tabs (incl. last) must not mint a new chat.
    tabBindingsRef.current.delete(tabId);
  }, []);

  const handleBrowserTabNavigated = useCallback(
    (info: { tabId: string; url: string; title: string }) => {
      const prev = tabBindingsRef.current.get(info.tabId) ?? null;
      const sharedId = currentChatIdRef.current || prev?.sessionId || newSessionId();

      // Freeze page-title churn mid-stream; never switch CHATID from navigation.
      if (streamingSessionsRef.current.has(sharedId)) {
        const title = (info.title || "").trim();
        if (prev && title && title !== prev.pageTitle) {
          const frozen = { ...prev, sessionId: sharedId, pageTitle: title };
          tabBindingsRef.current.set(info.tabId, frozen);
          if (info.tabId === activeTabIdRef.current) {
            setActiveBrowserMeta({
              title,
              pageKey: frozen.pageKey ?? null,
            });
          }
        }
        return;
      }

      const { binding } = resolveTabSession({
        tabId: info.tabId,
        url: info.url,
        title: info.title,
        prev,
        sharedSessionId: sharedId,
        pageKeyIndex: pageKeyIndexRef.current,
      });
      tabBindingsRef.current.set(info.tabId, binding);

      if (info.tabId !== activeTabIdRef.current) return;
      if (
        prev &&
        prev.pageKey === binding.pageKey &&
        prev.pageTitle === binding.pageTitle &&
        !binding.pendingVisitMarker
      ) {
        return;
      }
      activateTabBinding(binding);
    },
    [activateTabBinding]
  );

  const handleVisitMarkerConsumed = useCallback(() => {
    setPendingVisitMarker(false);
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    const b = tabBindingsRef.current.get(tabId);
    if (b) tabBindingsRef.current.set(tabId, { ...b, pendingVisitMarker: false });
  }, []);

  // API requests only when the user is authenticated (or account-less mode)
  const canFetch = checked && (!!user || authMode === "no-auth");

  useEffect(() => {
    if (!canFetch) return;
    let cancelled = false;
    fetchConnectionsStatus()
      .then((s) => {
        if (!cancelled) setNeedsLlmSetup(!!s.onboarding?.needsLlmSetup);
      })
      .catch(() => {
        if (!cancelled) setNeedsLlmSetup(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canFetch]);

  const loadChatList = useCallback(
    (opts?: { quiet?: boolean }) => {
      if (!opts?.quiet) {
        setListLoading(true);
        setListError(null);
      }
      return fetchChatList(searchQuery.trim() || undefined)
        .then((list) => {
          setChats((prev) => {
            const prevById = new Map(prev.map((c) => [c.id, c]));
            let index = { ...pageKeyIndexRef.current };
            const fromServer = list.map((c) => {
              const old = prevById.get(c.id);
              const serverPageKey = (c.browser_page_key || "").trim() || null;
              if (serverPageKey) {
                index = registerPageKeySession(index, serverPageKey, c.id);
              }
              const pageKey =
                serverPageKey ||
                Object.entries(index).find(([, sid]) => sid === c.id)?.[0] ||
                old?.browserPageKey ||
                undefined;
              // Unified chat: keep human/list title — do not rename to every surfed page.
              return {
                id: c.id,
                title: (old?.title || "").trim() || c.title,
                updatedAt: c.updated_at,
                messages: old?.messages ?? [],
                projectId: c.project_id ?? undefined,
                browserPageKey: pageKey ?? null,
                model:
                  typeof c.model === "string" && c.model.trim()
                    ? c.model.trim()
                    : old?.model?.trim() || null,
                pinned: typeof c.pinned === "boolean" ? c.pinned : !!old?.pinned,
                favorited: typeof c.favorited === "boolean" ? c.favorited : !!old?.favorited,
                forkedFrom: c.forked_from_chat_id ?? null,
                historyEvicted: old?.historyEvicted,
              };
            });
            pageKeyIndexRef.current = index;
            savePageKeyIndex(index);
            const serverIds = new Set(fromServer.map((c) => c.id));
            // Keep local-only browser chats (e.g. tool search) that never hit the gateway list yet.
            const localOnly = prev.filter(
              (c) =>
                !serverIds.has(c.id) &&
                ((c.messages?.length ?? 0) > 0 ||
                  !!c.historyEvicted ||
                  !!(c.model && c.model.trim()))
            );
            const merged = [...localOnly, ...fromServer].sort(compareChatItems);

            const keep = new Set<string>();
            for (const c of merged) keep.add(c.id);
            for (const b of tabBindingsRef.current.values()) keep.add(b.sessionId);
            const pruned = prunePageKeyIndex(pageKeyIndexRef.current, keep);
            if (pruned !== pageKeyIndexRef.current) {
              pageKeyIndexRef.current = pruned;
              savePageKeyIndex(pruned);
            }
            return merged;
          });
        })
        .catch((err) => {
          if (!opts?.quiet) setListError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!opts?.quiet) setListLoading(false);
        });
    },
    [searchQuery]
  );

  useEffect(() => {
    if (!canFetch) return;
    void loadChatList();
  }, [canFetch, loadChatList]);

  const applyHistory = useCallback((chatId: string, messages: Message[]) => {
    // Live stream owns the transcript — don't overwrite with stale server history.
    if (streamingSessionsRef.current.has(chatId)) return;
    historyLastAccessedRef.current.set(chatId, Date.now());
    setChats((prev) => {
      let changed = false;
      const next = prev.map((c) => {
        if (c.id !== chatId) return c;
        const merged = mergeHistoryWithVisitMarkers(chatId, messages, c.messages ?? []) as Message[];
        persistVisitMarkersFromMessages(chatId, merged);
        // Don't clobber a longer in-memory transcript (e.g. mid-send before DB flush)
        if ((c.messages?.length ?? 0) > merged.length && !c.historyEvicted) return c;
        const prevLast = c.messages?.[c.messages.length - 1];
        const nextLast = merged[merged.length - 1];
        if (
          c.messages?.length === merged.length &&
          prevLast?.role === nextLast?.role &&
          prevLast?.content === nextLast?.content
        ) {
          if (!c.historyEvicted) return c;
          changed = true;
          return { ...c, messages: merged, historyEvicted: false };
        }
        changed = true;
        return { ...c, messages: merged, historyEvicted: false };
      });
      // History for a session not yet in the list (reopen pageKey) — only if server returned rows.
      if (!prev.some((c) => c.id === chatId) && messages.length > 0) {
        const merged = mergeHistoryWithVisitMarkers(chatId, messages, []) as Message[];
        changed = true;
        return [
          {
            id: chatId,
            title: pageKeyLabel(
              Object.entries(pageKeyIndexRef.current).find(([, sid]) => sid === chatId)?.[0] ?? chatId
            ),
            updatedAt: Date.now(),
            messages: merged,
          },
          ...next,
        ];
      }
      return changed ? next : prev;
    });
  }, []);
  applyHistoryRef.current = applyHistory;

  const loadChatHistory = useCallback(
    (chatId: string) => {
      const existing = historyLoadPromisesRef.current.get(chatId);
      if (existing) return existing;
      const wasEvicted = chatsRef.current.find((chat) => chat.id === chatId)?.historyEvicted === true;
      if (wasEvicted) {
        setHistoryLoadingChatIds((prev) => (prev.includes(chatId) ? prev : [...prev, chatId]));
      }
      const request = fetchChatHistory(chatId)
        .then((messages) => {
          applyHistory(chatId, messages as Message[]);
        })
        .catch(() => {})
        .finally(() => {
          historyLoadPromisesRef.current.delete(chatId);
          if (wasEvicted) {
            setHistoryLoadingChatIds((prev) => prev.filter((id) => id !== chatId));
          }
        });
      historyLoadPromisesRef.current.set(chatId, request);
      return request;
    },
    [applyHistory]
  );

  // Sync list + open-chat history with PWA / other clients on the same gateway
  useEffect(() => {
    if (!canFetch) return;
    const quietRefresh = () => {
      void loadChatList({ quiet: true });
      if (currentChatId) void loadChatHistory(currentChatId);
    };
    const onVis = () => {
      if (document.visibilityState === "visible") quietRefresh();
    };
    window.addEventListener("focus", quietRefresh);
    document.addEventListener("visibilitychange", onVis);
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") quietRefresh();
    }, 4_000);
    return () => {
      window.removeEventListener("focus", quietRefresh);
      document.removeEventListener("visibilitychange", onVis);
      window.clearInterval(id);
    };
  }, [canFetch, loadChatList, loadChatHistory, currentChatId]);

  useEffect(() => {
    if (!canFetch) return;
    fetchProjectList()
      .then(setProjects)
      .catch(() => {});
  }, [canFetch]);

  useEffect(() => {
    if (!canFetch) return;
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults([]);
      setSearchResultsError(null);
      return;
    }
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      searchDebounceRef.current = null;
      setSearchResultsLoading(true);
      setSearchResultsError(null);
      fetchSearchResults(q)
        .then(setSearchResults)
        .catch((err) => setSearchResultsError(err instanceof Error ? err.message : String(err)))
        .finally(() => setSearchResultsLoading(false));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [canFetch, searchQuery]);

  const currentChat = currentChatId ? chats.find((c) => c.id === currentChatId) : null;

  useEffect(() => {
    const name = (currentChat?.title || "").trim();
    document.title = name ? `${name} — claw2` : "claw2";
    return () => {
      document.title = "claw2";
    };
  }, [currentChat?.title, currentChatId]);

  // Always reload history when switching chats (stale in-memory messages were the bug)
  useEffect(() => {
    if (!canFetch || !currentChatId) return;
    void loadChatHistory(currentChatId);
  }, [canFetch, currentChatId, loadChatHistory]);

  useEffect(() => {
    const protectedIds = new Set(streamingChatIds);
    if (currentChatId) protectedIds.add(currentChatId);
    for (const chat of chats) {
      if (chat.pinned) protectedIds.add(chat.id);
    }
    const evictedIds = selectInactiveHistoryEvictions(
      chats,
      protectedIds,
      historyLastAccessedRef.current
    );
    if (evictedIds.length === 0) return;
    for (const chatId of evictedIds) releaseChatTranscriptBlobPreviewUrls(chatId);
    setChats((prev) => evictChatHistories(prev, new Set(evictedIds)));
  }, [chats, currentChatId, streamingChatIds]);

  useEffect(() => {
    setRemovedImageUrls([]);
  }, [currentChatId]);

  const handleSelectChat = useCallback(
    (chatId: string) => {
      historyLastAccessedRef.current.set(chatId, Date.now());
      if (chatsRef.current.find((chat) => chat.id === chatId)?.historyEvicted) {
        setHistoryLoadingChatIds((prev) => (prev.includes(chatId) ? prev : [...prev, chatId]));
      }
      currentChatIdRef.current = chatId;
      setCurrentChatId(chatId);
      setAttentionChatIds((prev) => (prev.includes(chatId) ? prev.filter((id) => id !== chatId) : prev));
      setSearchQuery("");
      // Raise selected chat to the top of the sidebar (local + persist).
      setChats((prev) => {
        const idx = prev.findIndex((c) => c.id === chatId);
        if (idx < 0) return prev;
        const copy = [...prev];
        copy[idx] = { ...copy[idx]!, updatedAt: Date.now() };
        return copy.sort(compareChatItems);
      });
      void touchChat(chatId).catch(() => undefined);
      // Each chat has its own browser tab set — clear runtime bindings; electron restores tabs.
      tabBindingsRef.current.clear();
      activeTabIdRef.current = null;
      const browser = window.claw2Desktop?.browser;
      if (browser?.setWorkspace) void browser.setWorkspace(chatId);
      overlayIntentRef.current = chatId;
      overlayDismissedSessionRef.current = null;
      if (!location.pathname.startsWith("/chat")) navigate("/chat");
      if (mainSurfaceRef.current === "web") {
        void showOverlayForSession(chatId);
      } else {
        setWebAnswerOverlay(null);
      }
    },
    [location.pathname, navigate, showOverlayForSession]
  );

  const handleOpenChatFromSearch = useCallback(
    (chatId: string) => {
      handleSelectChat(chatId);
    },
    [handleSelectChat]
  );

  const handleSessionUpdate = useCallback((sessionId: string, title: string, messages: Message[]) => {
    persistVisitMarkersFromMessages(sessionId, messages);
    historyLastAccessedRef.current.set(sessionId, Date.now());

    const tabId = activeTabIdRef.current;
    const binding = tabId ? tabBindingsRef.current.get(tabId) : undefined;
    // Keep last-seen pageKey as soft meta; do not own the chat by URL / rename to page title.
    if (binding?.pageKey && messages.length > 0) {
      const updated = { ...binding, sessionId };
      tabBindingsRef.current.set(binding.tabId, updated);
      persistPageKeyBinding(binding.pageKey, sessionId);
    }
    for (const [id, b] of tabBindingsRef.current.entries()) {
      if (b.sessionId !== sessionId) {
        tabBindingsRef.current.set(id, { ...b, sessionId });
      }
    }

    const pageKeyForChat =
      binding?.pageKey ||
      [...tabBindingsRef.current.values()].find((b) => b.sessionId === sessionId)?.pageKey ||
      undefined;

    setChats((prev) => {
      const copy = [...prev];
      const idx = copy.findIndex((c) => c.id === sessionId);
      const existing = idx >= 0 ? copy[idx] : undefined;
      const listTitle = resolveListTitle(existing?.title, title);
      const item: ChatItem = {
        id: sessionId,
        title: listTitle,
        updatedAt: Date.now(),
        messages,
        projectId: pendingProjectId ?? existing?.projectId ?? undefined,
        browserPageKey: pageKeyForChat ?? existing?.browserPageKey ?? null,
        model: existing?.model ?? null,
        pinned: existing?.pinned,
        favorited: existing?.favorited,
        titleManual: existing?.titleManual,
        hasImages: existing?.hasImages,
        hasDocs: existing?.hasDocs,
        historyEvicted: false,
      };
      if (idx >= 0) copy[idx] = item;
      else copy.unshift(item);
      return copy.sort(compareChatItems);
    });
    // Don't yank focus back if the user switched to another chat mid-stream.
    if (currentChatIdRef.current === sessionId) {
      setCurrentChatId(sessionId);
      setPendingProjectId(null);
    }
  }, [pendingProjectId, persistPageKeyBinding]);

  const reclaimComposerFocus = useCallback(() => {
    // window.confirm / BrowserView on Windows often leave the shell without a keyboard target.
    const browser = window.claw2Desktop?.browser;
    const kick = () => {
      void browser?.restoreShellFocus?.();
    };
    kick();
    window.setTimeout(kick, 0);
    window.setTimeout(kick, 50);
  }, []);

  const handleDeleteChat = useCallback(async (chatId: string) => {
    try {
      await deleteChat(chatId);
      releaseChatTranscriptBlobPreviewUrls(chatId);
      clearVisitMarkers(chatId);
      void window.claw2Desktop?.browser?.forgetWorkspace?.(chatId);
      for (const [tabId, b] of [...tabBindingsRef.current.entries()]) {
        if (b.sessionId === chatId) tabBindingsRef.current.delete(tabId);
      }
      const nextIndex = { ...pageKeyIndexRef.current };
      let indexChanged = false;
      for (const [k, sid] of Object.entries(nextIndex)) {
        if (sid === chatId) {
          delete nextIndex[k];
          indexChanged = true;
        }
      }
      if (indexChanged) {
        pageKeyIndexRef.current = nextIndex;
        savePageKeyIndex(nextIndex);
      }
      streamingSessionsRef.current.delete(chatId);
      if (overlayIntentRef.current === chatId) overlayIntentRef.current = null;
      if (overlayDismissedSessionRef.current === chatId) overlayDismissedSessionRef.current = null;

      const wasCurrent =
        currentChatIdRef.current === chatId || currentChatId === chatId;
      handleAbortSession(chatId);
      setAttentionChatIds((prev) => prev.filter((id) => id !== chatId));
      setChats((prev) => prev.filter((c) => c.id !== chatId));
      if (wasCurrent) {
        setWebAnswerOverlay(null);
        setActiveBrowserMeta({ title: null, pageKey: null });
        setCurrentChatId(newProvisionalSessionId());
        setChatEpoch((n) => n + 1);
      }
    } catch {
      // ignore
    } finally {
      reclaimComposerFocus();
    }
  }, [currentChatId, reclaimComposerFocus, handleAbortSession]);

  const handleChatProjectChange = useCallback(async (chatId: string, projectId: string | null, ids?: string[]) => {
    // ids = the whole fork tree when the user chose "add the whole tree".
    const targetIds = ids?.length ? ids : [chatId];
    const idSet = new Set(targetIds);
    try {
      await Promise.all(targetIds.map((id) => updateChatProject(id, projectId)));
      setChats((prev) =>
        prev.map((c) => (idSet.has(c.id) ? { ...c, projectId: projectId ?? undefined } : c))
      );
    } catch {
      // ignore
    }
  }, []);

  const handleChatPinnedChange = useCallback(async (chatId: string, pinned: boolean) => {
    const id = chatId.trim();
    if (!id) return;
    setChats((prev) =>
      prev
        .map((c) => (c.id === id ? { ...c, pinned } : c))
        .sort(compareChatItems)
    );
    try {
      await updateChatPinned(id, pinned);
    } catch {
      setChats((prev) =>
        prev
          .map((c) => (c.id === id ? { ...c, pinned: !pinned } : c))
          .sort(compareChatItems)
      );
    }
  }, []);

  const handleChatFavoritedChange = useCallback(async (chatId: string, favorited: boolean) => {
    const id = chatId.trim();
    if (!id) return;
    setChats((prev) =>
      prev
        .map((c) => (c.id === id ? { ...c, favorited } : c))
        .sort(compareChatItems)
    );
    try {
      await updateChatFavorited(id, favorited);
    } catch {
      setChats((prev) =>
        prev
          .map((c) => (c.id === id ? { ...c, favorited: !favorited } : c))
          .sort(compareChatItems)
      );
    }
  }, []);

  const handleRenameChat = useCallback(async (chatId: string, title: string) => {
    const id = chatId.trim();
    const next = title.trim().slice(0, 300);
    if (!id || !next) return;
    const previous = chats.find((c) => c.id === id)?.title ?? "";
    setChats((prev) => prev.map((c) => (c.id === id ? { ...c, title: next, titleManual: true } : c)));
    try {
      await renameChat(id, next);
    } catch {
      setChats((prev) => prev.map((c) => (c.id === id ? { ...c, title: previous || next } : c)));
    }
  }, [chats]);

  const handleExportChat = useCallback(async (chatId: string) => {
    const chat = chats.find((c) => c.id === chatId);
    let messages = chat?.messages ?? [];
    if (messages.length === 0) {
      try {
        messages = await fetchChatHistory(chatId);
      } catch {
        return;
      }
    }
    const title = chat?.title ?? chatId;
    const lines: string[] = [`# ${title}`, "", t("export.mdHeader", { date: new Date().toLocaleString(locale) }), ""];
    for (const m of messages) {
      lines.push(`## ${m.role === "user" ? t("common.you") : t("common.agent")}`, "", m.content, "");
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown; charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^\p{L}\p{N}\s_-]/gu, "_").slice(0, 50)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [chats, locale, t]);

  const handleExportClawCache = useCallback(async (chatId: string) => {
    const chat = chats.find((c) => c.id === chatId);
    const title = chat?.title ?? chatId;
    const cacheId =
      chatId
        .replace(/^sess_/, "")
        .replace(/[^a-zA-Z0-9._-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48) || `export-${Date.now()}`;
    try {
      await exportChatClawCache({ sessionId: chatId, name: title, cacheId });
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t("export.clawCacheFailed"));
    }
  }, [chats, t]);

  const handleNewChat = useCallback((projectId?: string | null) => {
    const nextId = newProvisionalSessionId();
    overlayIntentRef.current = null;
    overlayDismissedSessionRef.current = null;
    setWebAnswerOverlay(null);
    setPendingVisitMarker(false);
    setActiveBrowserMeta({ title: null, pageKey: null });
    // Park previous chat's tabs; new chat gets a fresh blank workspace.
    tabBindingsRef.current.clear();
    activeTabIdRef.current = null;
    const browser = window.claw2Desktop?.browser;
    if (browser?.setWorkspace) void browser.setWorkspace(nextId);
    currentChatIdRef.current = nextId;
    setCurrentChatId(nextId);
    setPendingProjectId(projectId ?? null);
    setSearchQuery("");
    setChatEpoch((n) => n + 1);
    reclaimComposerFocus();
  }, [reclaimComposerFocus]);

  /**
   * Fork a chat: full duplicate, or a branch cut at the first `upToCount` messages
   * (fork-from-message). Files stay shared (links suffice); the fork inherits
   * project/model/prompt context and opens immediately after creation.
   */
  const handleDuplicateChat = useCallback(
    async (chatId: string, opts?: { upToCount?: number; title?: string }): Promise<string | null> => {
      const id = chatId.trim();
      if (!id) return null;
      const source = chatsRef.current.find((c) => c.id === id);
      const baseTitle = (source?.title || "").trim();
      const fallbackTitle = baseTitle ? `${baseTitle}${t("sidebar.duplicateChatSuffix")}` : "";
      try {
        const { sessionId: newId, chat } = await duplicateChat(id, {
          upToCount: opts?.upToCount,
          title: opts?.title ?? fallbackTitle,
        });
        const forkItem: ChatItem = {
          id: newId,
          title: (chat?.title || "").trim() || fallbackTitle || newId,
          updatedAt: chat?.updated_at ?? Date.now(),
          messages: [],
          projectId: chat?.project_id ?? source?.projectId ?? undefined,
          browserPageKey: chat?.browser_page_key ?? source?.browserPageKey ?? null,
          model: chat?.model ?? source?.model ?? null,
          pinned: false,
          favorited: false,
          forkedFrom: chat?.forked_from_chat_id ?? id,
        };
        historyLastAccessedRef.current.set(newId, Date.now());
        setChats((prev) => [...prev, forkItem].sort(compareChatItems));
        handleSelectChat(newId);
        return newId;
      } catch (err) {
        window.alert(err instanceof Error ? err.message : t("sidebar.duplicateChatFailed"));
        return null;
      } finally {
        reclaimComposerFocus();
      }
    },
    [handleSelectChat, reclaimComposerFocus, t]
  );

  useEffect(() => {
    const api = window.claw2Desktop;
    if (!api?.onMenu) return;
    const offs = [
      api.onMenu("new-chat", () => {
        navigate("/chat");
        handleNewChat(null);
      }),
      api.onMenu("settings", () => navigate("/cabinet/settings")),
    ];
    return () => offs.forEach((off) => off());
  }, [handleNewChat, navigate]);

  useEffect(() => {
    const askFromSelection = (payload: { text?: string; url?: string; title?: string } | null | undefined) => {
      const text = payload?.text?.trim();
      if (!text) return;
      navigate("/chat");
      setMainSurface("web");
      writeMainSurface("web");
      setSeedPageContext({
        text,
        url: payload?.url,
        title: payload?.title,
      });
      setSeedPrompt(t("browser.askSelectionPrompt"));
    };

    const unsubs: Array<() => void> = [];
    const browser = window.claw2Desktop?.browser;
    if (browser?.onAskSelection) {
      unsubs.push(browser.onAskSelection((payload) => askFromSelection(payload)));
    }
    const onDomAsk = (ev: Event) => {
      askFromSelection((ev as CustomEvent<{ text?: string; url?: string; title?: string }>).detail);
    };
    window.addEventListener("claw2:ask-selection", onDomAsk);
    unsubs.push(() => window.removeEventListener("claw2:ask-selection", onDomAsk));
    return () => {
      for (const u of unsubs) u();
    };
  }, [navigate, t]);

  const handleToggleMainSurface = useCallback(() => {
    setMainSurface((prev) => {
      const next: MainSurface = prev === "web" ? "chat" : "web";
      writeMainSurface(next);
      if (next === "chat") {
        setWebAnswerOverlay(null);
        const browser = window.claw2Desktop?.browser;
        if (browser?.hide) void browser.hide().then(() => browser.restoreShellFocus?.());
      }
      return next;
    });
    if (!location.pathname.startsWith("/chat")) {
      navigate("/chat");
    }
  }, [location.pathname, navigate]);

  const handleOpenBrowserUrl = useCallback(
    (url: string) => {
      const trimmed = url.trim();
      if (!trimmed) return;
      const browser = window.claw2Desktop?.browser;
      if (browser?.createTab || browser?.navigate) {
        setMainSurface("web");
        writeMainSurface("web");
        if (!location.pathname.startsWith("/chat")) navigate("/chat");
        if (browser.createTab) void browser.createTab(trimmed);
        else void browser.navigate?.(trimmed);
        return;
      }
      window.open(trimmed, "_blank", "noopener,noreferrer");
    },
    [location.pathname, navigate]
  );

  const handleAddressSearch = useCallback(
    async (query: string) => {
      const q = query.trim();
      if (!q) return;
      const browser = window.claw2Desktop?.browser;
      const ddg = `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;

      let useLlm = false;
      try {
        const cfg = await getConfig();
        const tools = cfg.tools as { search?: { useLlmInWeb?: boolean } } | undefined;
        useLlm = tools?.search?.useLlmInWeb === true;
      } catch {
        /* fall through */
      }

      if (useLlm) {
        const prompt =
          locale === "ru"
            ? `Найди в интернете наиболее релевантные результаты по запросу и дай список со ссылками:\n${q}`
            : `Search the web for the most relevant results and list them with links:\n${q}`;
        setSeedPrompt(prompt);
        return;
      }

      try {
        const result = await browserSearch(q);
        if (result.ok && result.markdown.trim()) {
          const userLine =
            locale === "ru" ? `Поиск: ${q}` : `Search: ${q}`;
          const overlayMessages = [
            { role: "user" as const, content: userLine },
            { role: "assistant" as const, content: result.markdown },
          ];
          setWebAnswerOverlay({
            messages: overlayMessages,
            streaming: false,
          });
          const sessionId = currentChatIdRef.current || newSessionId();
          const existing = chatsRef.current.find((c) => c.id === sessionId);
          const base = existing?.messages ?? [];
          const markerAt = new Date().toISOString();
          const siteForMarker =
            (activeBrowserMeta.title || "").trim() ||
            (activeBrowserMeta.pageKey ? pageKeyLabel(activeBrowserMeta.pageKey) : "") ||
            markerAt;
          const withPending =
            pendingVisitMarker && base.length > 0
              ? [...base, { role: "visit_marker" as const, content: siteForMarker, at: markerAt }]
              : base;
          const messages: Message[] = [
            ...withPending,
            { role: "user", content: userLine },
            { role: "assistant", content: result.markdown },
          ];
          handleSessionUpdate(
            sessionId,
            locale === "ru" ? `Поиск: ${q.slice(0, 40)}` : `Search: ${q.slice(0, 40)}`,
            messages
          );
          if (pendingVisitMarker) handleVisitMarkerConsumed();
          return;
        }
      } catch {
        /* DDG fallback */
      }
      void browser?.navigate(ddg, { allowSearchFallback: true });
    },
    [
      locale,
      handleSessionUpdate,
      pendingVisitMarker,
      handleVisitMarkerConsumed,
      activeBrowserMeta.title,
      activeBrowserMeta.pageKey,
    ]
  );

  // Hide BrowserView when leaving the chat stage (cabinet / gallery / …)
  useEffect(() => {
    const browser = window.claw2Desktop?.browser;
    if (!browser) return;
    const onChat = location.pathname.startsWith("/chat") || location.pathname === "/";
    if (!onChat || mainSurface !== "web") {
      void browser.hide();
    }
  }, [location.pathname, mainSurface]);

  const handleProjectCreated = useCallback((newProject: ProjectListItemApi) => {
    setProjects((prev) => [...prev, newProject]);
  }, []);

  const handleProjectUpdated = useCallback((updated: ProjectListItemApi) => {
    setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  }, []);

  const handleDeleteProject = useCallback(async (projectId: string) => {
    try {
      await deleteProject(projectId);
      setProjects((prev) => prev.filter((p) => p.id !== projectId));
    } catch {
      // ignore
    }
  }, []);

  if (!checked) {
    return (
      <div className="auth-loading" style={{ padding: "2rem", textAlign: "center" }}>
        {t("common.loading")}
      </div>
    );
  }
  if (authMode === "auth" && !user) {
    return <Navigate to="/login" replace />;
  }

  const sidebarProps = {
    chats,
    projects,
    currentChatId,
    onSelectChat: handleSelectChat,
    onNewChat: handleNewChat,
    onProjectCreated: handleProjectCreated,
    onProjectUpdated: handleProjectUpdated,
    onDeleteProject: handleDeleteProject,
    searchQuery,
    onSearchChange: setSearchQuery,
    listLoading,
    listError,
    onDeleteChat: handleDeleteChat,
    onExportChat: handleExportChat,
    onExportClawCache: handleExportClawCache,
    onDuplicateChat: handleDuplicateChat,
    onChatProjectChange: handleChatProjectChange,
    onChatPinnedChange: handleChatPinnedChange,
    onChatFavoritedChange: handleChatFavoritedChange,
    onRenameChat: handleRenameChat,
    onDynamicPrompt: (text: string) => {
      setSearchQuery("");
      setSeedPrompt(text);
    },
    sidebarRefreshKey,
    mainSurface,
    onToggleMainSurface: handleToggleMainSurface,
    streamingChatIds,
    attentionChatIds,
  };

  const outletContext: ChatPageOutletContext = {
    chats,
    projects,
    currentChatId,
    setCurrentChatId,
    searchQuery,
    setSearchQuery,
    listLoading,
    listError,
    searchResults,
    searchResultsLoading,
    searchResultsError,
  pendingProjectId,
  currentChat: currentChat ?? undefined,
  chatEpoch,
    onOpenChatFromSearch: handleOpenChatFromSearch,
    onOpenPastChat: handleSelectChat,
    onSessionUpdate: handleSessionUpdate,
    onDeleteChat: handleDeleteChat,
    onChatProjectChange: handleChatProjectChange,
    onExportChat: handleExportChat,
    onDuplicateChat: handleDuplicateChat,
    onNewChat: handleNewChat,
    onProjectCreated: handleProjectCreated,
    onProjectUpdated: handleProjectUpdated,
    onDeleteProject: handleDeleteProject,
    seedPrompt,
    onSeedPromptConsumed: () => {
      setSeedPrompt(null);
      setSeedPageContext(null);
    },
    seedPageContext,
    onSeedPrompt: (text: string) => {
      setSearchQuery("");
      setSeedPrompt(text);
    },
    onSidebarUpdated: () => setSidebarRefreshKey((k) => k + 1),
    surfaceMode: mainSurface,
    onWebAnswerOverlay: (overlay) => {
      if (overlay) overlayDismissedSessionRef.current = null;
      setWebAnswerOverlay(overlay);
    },
    onOpenBrowserUrl: handleOpenBrowserUrl,
    pendingVisitMarker,
    onVisitMarkerConsumed: handleVisitMarkerConsumed,
    onStreamingChange: handleStreamingChange,
    onStreamProgress: handleStreamProgress,
    onStreamComplete: handleStreamComplete,
    onRegisterStreamAbort: handleRegisterStreamAbort,
    onAbortSession: handleAbortSession,
    onChatModelChange: handleChatModelChange,
    streamingChatIds,
    historyLoadingChatIds,
    removedImageUrls,
    onImageRemoved: (url: string) => {
      setRemovedImageUrls((prev) => (prev.includes(url) ? prev : [...prev, url]));
      if (!currentChatId) return;
      setChats((prev) =>
        prev.map((c) =>
          c.id === currentChatId && c.messages?.length
            ? { ...c, messages: stripImageFromMessages(c.messages, url) }
            : c
        )
      );
    },
  };

  // Render by pathname: nested <Routes> under parent path="/chat/*" sees path remainder "",
  // so path="/chat" never matches and content did not render. Render chat/cabinet by path explicitly.
  // Do not unmount ChatPage when going to cabinet — otherwise the stream aborts and progress is lost.
  if (location.pathname.startsWith("/chat/room")) {
    return <Navigate to="/chat" replace />;
  }

  if (needsLlmSetup === null && canFetch) {
    return (
      <div className="auth-loading" style={{ padding: "2rem", textAlign: "center" }}>
        {t("app.loading")}
      </div>
    );
  }

  if (needsLlmSetup) {
    return (
      <LlmSetupScreen
        onReady={() => {
          setNeedsLlmSetup(false);
          navigate("/cabinet/persona?welcome=1", { replace: true });
        }}
      />
    );
  }

  const isCabinet = location.pathname.startsWith("/cabinet");
  const isGallery = location.pathname === "/gallery" || location.pathname.startsWith("/gallery/");
  const isDocuments =
    location.pathname === "/documents" || location.pathname.startsWith("/documents/");
  const isCalls = location.pathname === "/calls" || location.pathname.startsWith("/calls/");
  const hideChat = isCabinet || isGallery || isDocuments || isCalls;
  const webSplit = !hideChat && mainSurface === "web";

  return (
    <ChatPageProvider value={{
      ...outletContext,
      browserChatTitle: activeBrowserMeta.title,
      browserPageKey: activeBrowserMeta.pageKey,
    }}>
      <Layout {...sidebarProps}>
        <div
          className={`chat-keep-alive${webSplit ? " chat-keep-alive--web" : ""}`}
          style={{
            display: hideChat ? "none" : "flex",
            flexDirection: "column",
            height: "100%",
            minHeight: 0,
          }}
          aria-hidden={hideChat}
        >
          {webSplit ? (
            <BrowserSurface
              active={!hideChat && mainSurface === "web"}
              workspaceChatId={currentChatId}
              answerOverlay={webAnswerOverlay}
              chatHistoryAvailable={
                !!currentChatId &&
                ((chats.find((c) => c.id === currentChatId)?.messages?.length ?? 0) > 0 ||
                  !!webAnswerOverlay?.messages?.length)
              }
              onOpenAnswerOverlay={() => {
                const sid = currentChatIdRef.current;
                if (!sid) return;
                overlayIntentRef.current = sid;
                overlayDismissedSessionRef.current = null;
                void showOverlayForSession(sid);
              }}
              onCloseAnswerOverlay={() => {
                overlayIntentRef.current = null;
                const sid = currentChatIdRef.current;
                if (sid) overlayDismissedSessionRef.current = sid;
                setWebAnswerOverlay(null);
                const browser = window.claw2Desktop?.browser;
                if (browser?.restoreShellFocus) void browser.restoreShellFocus();
              }}
              onAddressSearch={handleAddressSearch}
              onOpenOverlayLink={handleOpenBrowserUrl}
              onActiveTabChange={handleBrowserActiveTabChange}
              onTabClosed={handleBrowserTabClosed}
              onTabNavigated={handleBrowserTabNavigated}
            />
          ) : null}
          <div className={`chat-stage-panel${webSplit ? " chat-stage-panel--web-bar" : ""}`}>
            <ChatPage />
          </div>
        </div>
        {isGallery ? <GalleryPage /> : null}
        {isDocuments ? <DocumentsPage /> : null}
        {isCalls ? <CallsPage /> : null}
        {isCabinet ? <CabinetPage /> : null}
      </Layout>
    </ChatPageProvider>
  );
}
