import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import {
  displayUrl,
  loadUrlHistory,
  MAX_URL_SUGGESTIONS,
  recordUrlVisit,
  removeUrlHistoryEntry,
  suggestUrlHistory,
  type UrlHistoryEntry,
} from "../browser/urlHistory";
import { isBookmarked, loadBookmarks, toggleBookmark, type BrowserBookmark } from "../browser/bookmarks";
import { formatVisitMarkerLabel } from "../browser/visitMarkers";
import { useT } from "../i18n";
import { markdownComponents } from "./markdownComponents";
import { ChartCell } from "./ChartCell";
import { resolveAssistantDisplay, type DisplayCell } from "../lib/messageCells";
import { renderCellSegments, resolveMediaSrc } from "../lib/cellRender";
import { IMAGE_DELETED_CELL_TYPE } from "../lib/galleryActions";
import { apiBase } from "../config";
import { IconBrightness } from "./icons";
import { ChatWorkingIndicator } from "./ChatWorkingIndicator";
import {
  ContextMenu,
  concealBrowserViewForMenu,
  readClipboard,
  revealBrowserViewAfterMenu,
  selectionTextIn,
  writeClipboard,
  type ContextMenuItem,
  type ContextMenuState,
} from "./ContextMenu";
import { markdownToPlainText } from "../utils/markdown-to-plain";
import type {
  BrowserBounds,
  BrowserDownloadEvent,
  BrowserFailLoad,
  BrowserNavState,
  BrowserTabInfo,
} from "../desktop";

const OVERLAY_BOTTOM_GAP_PX = 15;
const OVERLAY_TONE_STORAGE_KEY = "claw2.browserOverlayTone";
/** Default matches previous glass look (~0.45). 0 = lighter, 100 = darker. */
const OVERLAY_TONE_DEFAULT = 45;

function readOverlayTone(): number {
  try {
    const raw = localStorage.getItem(OVERLAY_TONE_STORAGE_KEY);
    if (raw == null) return OVERLAY_TONE_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return OVERLAY_TONE_DEFAULT;
    return Math.min(100, Math.max(0, Math.round(n)));
  } catch {
    return OVERLAY_TONE_DEFAULT;
  }
}

function writeOverlayTone(value: number): void {
  try {
    localStorage.setItem(OVERLAY_TONE_STORAGE_KEY, String(value));
  } catch {
    /* ignore */
  }
}

function OverlayCell({ cell }: { cell: DisplayCell }) {
  if (cell.type === "chart") {
    return (
      <div className="chat-cell">
        <ChartCell content={cell.content} />
      </div>
    );
  }
  if (cell.type === "html") {
    return (
      <div className="chat-cell">
        <div className="chat-cell-html" dangerouslySetInnerHTML={{ __html: cell.content }} />
      </div>
    );
  }
  if (cell.type === IMAGE_DELETED_CELL_TYPE) {
    return <div className="chat-cell-media-fallback">—</div>;
  }
  const url = resolveMediaSrc((cell.content ?? "").trim(), apiBase);
  if (!url) return null;
  if (cell.type === "audio") {
    return (
      <div className="chat-cell">
        <audio className="chat-cell-audio" controls src={url} preload="metadata" />
      </div>
    );
  }
  if (cell.type === "video") {
    return (
      <div className="chat-cell">
        <video className="chat-cell-video" controls src={url} preload="metadata" />
      </div>
    );
  }
  if (cell.type === "image") {
    return (
      <div className="chat-cell">
        <div className="chat-cell-image-wrap">
          <img className="chat-cell-image" src={url} alt="" />
        </div>
      </div>
    );
  }
  return (
    <div className="chat-cell">
      <pre className="chat-cell-raw">{cell.content}</pre>
    </div>
  );
}

function roundBounds(rect: DOMRect): BrowserBounds {
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

function looksLikeUrlOrHost(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (/^https?:\/\//i.test(s) || s === "about:blank") return true;
  return /^[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(s);
}

function duckDuckGoUrl(query: string): string {
  return `https://duckduckgo.com/?q=${encodeURIComponent(query.trim())}`;
}

function IconNavBack({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconNavForward({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconNavReload({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M20 12a8 8 0 1 1-2.2-5.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <path d="M20 4v5h-5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconNavStop({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
    </svg>
  );
}
function IconHome({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 10.5L12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5z" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" />
    </svg>
  );
}
function IconLock({ size = 14, open = false }: { size?: number; open?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      {open ? (
        <path d="M8 11V8a4 4 0 0 1 7.5-2" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      ) : (
        <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      )}
      <rect x="6" y="11" width="12" height="9" rx="2" stroke="currentColor" strokeWidth="1.75" />
    </svg>
  );
}
function IconStar({ size = 18, filled = false }: { size?: number; filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} aria-hidden>
      <path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.8 6.7 19.6l1-5.8-4.2-4.1 5.9-.9L12 3.5z" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" />
    </svg>
  );
}
function IconBookmarks({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M7 4h7a2 2 0 0 1 2 2v14l-5.5-3L5 20V6a2 2 0 0 1 2-2z" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" />
      <path d="M16 6h1a2 2 0 0 1 2 2v12l-2-1.1" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconFind({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.75" />
      <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}
function IconPrint({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M7 8V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v3" stroke="currentColor" strokeWidth="1.75" />
      <path d="M7 15H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-2" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" />
      <rect x="7" y="14" width="10" height="6" rx="1" stroke="currentColor" strokeWidth="1.75" />
    </svg>
  );
}
function IconZoomOut({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.75" />
      <path d="M8.5 11h5M16 16l4.5 4.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}
function IconZoomIn({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.75" />
      <path d="M11 8.5v5M8.5 11h5M16 16l4.5 4.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}
function IconPlus({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}
function IconClose({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function IconOverlayClose({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

const overlaySanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code || []), ["className"]],
    span: [...(defaultSchema.attributes?.span || []), ["className"]],
    // Keep default `href` allowlist (http/https); only add target/rel.
    a: [...(defaultSchema.attributes?.a || []), "target", "rel"],
  },
};

export type BrowserOverlayMessage = {
  role: "user" | "assistant" | "visit_marker";
  content: string;
  at?: string;
  /** Inline cells for [CELL_N] placeholders (images, charts, html). */
  cells?: DisplayCell[];
};

export type BrowserAnswerOverlay = {
  messages: BrowserOverlayMessage[];
  streaming?: boolean;
};

type Props = {
  active: boolean;
  /** Chat that owns this browse workspace (tab set). */
  workspaceChatId?: string | null;
  answerOverlay?: BrowserAnswerOverlay | null;
  /** Current chat has messages — show FAB to reopen overlay. */
  chatHistoryAvailable?: boolean;
  onOpenAnswerOverlay?: () => void;
  onCloseAnswerOverlay?: () => void;
  /** Non-URL address bar submit → search in browser chat (parent). */
  onAddressSearch?: (query: string) => void | Promise<void>;
  /** Open a URL from the answer overlay — must be a new tab (parent createTab). */
  onOpenOverlayLink?: (url: string) => void;
  /** Canonical active tab (tabs-changed / switch). */
  onActiveTabChange?: (tabId: string | null) => void;
  /** Tab removed from the pool. */
  onTabClosed?: (tabId: string) => void;
  /** Navigation update for a tab (parent applies chat policy only if active). */
  onTabNavigated?: (info: { tabId: string; url: string; title: string }) => void;
};

export function BrowserSurface({
  active,
  workspaceChatId = null,
  answerOverlay = null,
  chatHistoryAvailable = false,
  onOpenAnswerOverlay,
  onCloseAnswerOverlay,
  onAddressSearch,
  onOpenOverlayLink,
  onActiveTabChange,
  onTabClosed,
  onTabNavigated,
}: Props) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [nav, setNav] = useState<BrowserNavState>({
    url: "",
    title: "",
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    zoomFactor: 1,
    secure: false,
  });
  const [tabs, setTabs] = useState<BrowserTabInfo[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [urlHistory, setUrlHistory] = useState<UrlHistoryEntry[]>(() => loadUrlHistory());
  const [bookmarks, setBookmarks] = useState<BrowserBookmark[]>(() => loadBookmarks());
  const [urlFocused, setUrlFocused] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [activeSuggest, setActiveSuggest] = useState(-1);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [siteInfoOpen, setSiteInfoOpen] = useState(false);
  const [siteInfo, setSiteInfo] = useState<Awaited<ReturnType<NonNullable<typeof browserApi>["getSiteInfo"]>> | null>(null);
  const [failBanner, setFailBanner] = useState<BrowserFailLoad | null>(null);
  const [certBanner, setCertBanner] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<BrowserDownloadEvent[]>([]);
  const [overlayCtxMenu, setOverlayCtxMenu] = useState<ContextMenuState | null>(null);
  const [urlCtxMenu, setUrlCtxMenu] = useState<ContextMenuState | null>(null);
  const browserApi = typeof window !== "undefined" ? window.claw2Desktop?.browser : undefined;
  const hasDesktopBrowser = !!browserApi;
  const overlayOpen = !!answerOverlay;
  const overlayScrollRef = useRef<HTMLDivElement>(null);
  const toneWrapRef = useRef<HTMLDivElement>(null);
  const [overlayTone, setOverlayTone] = useState(readOverlayTone);
  const [tonePanelOpen, setTonePanelOpen] = useState(false);
  const stickOverlayToBottomRef = useRef(true);
  const [pageSnapshot, setPageSnapshot] = useState<string | null>(null);
  const snapshotForOverlayRef = useRef<string | null>(null);
  const lastRecordedUrlRef = useRef("");

  const suggestions = useMemo(() => {
    const current = (nav.url || "").trim();
    const draft = urlDraft.trim();
    const query = !urlFocused ? "" : draft === "" || draft === current ? "" : urlDraft;
    return suggestUrlHistory(query, MAX_URL_SUGGESTIONS, urlHistory);
  }, [urlDraft, urlFocused, urlHistory, nav.url]);
  const showSuggestions = suggestOpen && urlFocused && suggestions.length > 0;
  const starred = isBookmarked(nav.url || "", bookmarks);

  const scrollOverlayToBottom = useCallback(() => {
    const el = overlayScrollRef.current;
    if (!el) return;
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
  }, []);

  useEffect(() => {
    if (!overlayOpen) {
      stickOverlayToBottomRef.current = true;
      return;
    }
    const el = overlayScrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickOverlayToBottomRef.current = dist <= OVERLAY_BOTTOM_GAP_PX;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [overlayOpen]);

  useEffect(() => {
    if (!overlayOpen || !answerOverlay) return;
    if (!stickOverlayToBottomRef.current && !answerOverlay.streaming) return;
    if (answerOverlay.streaming) stickOverlayToBottomRef.current = true;
    if (!stickOverlayToBottomRef.current) return;
    const id = requestAnimationFrame(() => scrollOverlayToBottom());
    return () => cancelAnimationFrame(id);
  }, [overlayOpen, answerOverlay, scrollOverlayToBottom]);

  const syncBounds = useCallback(() => {
    if (!active || !browserApi || !hostRef.current || overlayOpen) return;
    const bounds = roundBounds(hostRef.current.getBoundingClientRect());
    if (bounds.width < 2 || bounds.height < 2) return;
    void browserApi.setBounds(bounds);
  }, [active, browserApi, overlayOpen]);

  // Native floating FAB over the page (fixed bottom-right) — no reserved strip.
  useEffect(() => {
    if (!browserApi?.setHistoryFabVisible) return;
    const want = active && !overlayOpen && chatHistoryAvailable;
    void browserApi.setHistoryFabVisible(want);
    return () => {
      void browserApi.setHistoryFabVisible?.(false);
    };
  }, [active, overlayOpen, chatHistoryAvailable, browserApi]);

  useEffect(() => {
    if (!browserApi?.onOpenHistoryOverlay || !onOpenAnswerOverlay) return;
    return browserApi.onOpenHistoryOverlay(() => onOpenAnswerOverlay());
  }, [browserApi, onOpenAnswerOverlay]);

  useEffect(() => {
    if (!browserApi?.onNavChanged) return;
    return browserApi.onNavChanged((state) => {
      setNav(state);
      if (state.tabId) setActiveTabId(state.tabId);
      const u = state.url || "";
      if (document.activeElement !== urlInputRef.current) {
        // New / blank tabs must clear the omnibox — do not keep the previous tab's URL.
        setUrlDraft(!u || u === "about:blank" ? "" : u);
      }
      if (u && u !== "about:blank") {
        const key = `${u}\0${state.title || ""}`;
        if (lastRecordedUrlRef.current !== key) {
          lastRecordedUrlRef.current = key;
          setUrlHistory(recordUrlVisit(u, state.title || ""));
        }
      }
      if (!state.isLoading) setFailBanner(null);
      if (state.tabId) {
        onTabNavigated?.({
          tabId: state.tabId,
          url: state.url || "",
          title: state.title || "",
        });
      }
    });
  }, [browserApi, onTabNavigated]);

  const knownTabIdsRef = useRef<Set<string>>(new Set());
  const lastActiveTabNotifyRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!browserApi?.onTabsChanged) return;
    return browserApi.onTabsChanged((payload) => {
      const nextTabs = payload.tabs || [];
      setTabs(nextTabs);
      const nextActive = payload.activeTabId;
      setActiveTabId(nextActive);

      const activeTab = nextTabs.find((t) => t.id === nextActive);
      const activeUrl = activeTab?.url || "";
      if (document.activeElement !== urlInputRef.current) {
        setUrlDraft(!activeUrl || activeUrl === "about:blank" ? "" : activeUrl);
      }

      // Notify parent only when the active tab id changes (not on every nav-driven tabs-changed).
      if (lastActiveTabNotifyRef.current !== nextActive) {
        lastActiveTabNotifyRef.current = nextActive;
        onActiveTabChange?.(nextActive);
      }

      const nextIds = new Set(nextTabs.map((t) => t.id));
      for (const id of knownTabIdsRef.current) {
        if (!nextIds.has(id)) onTabClosed?.(id);
      }
      knownTabIdsRef.current = nextIds;
    });
  }, [browserApi, onActiveTabChange, onTabClosed]);

  useEffect(() => {
    if (!browserApi?.onFailLoad) return;
    return browserApi.onFailLoad((payload) => setFailBanner(payload));
  }, [browserApi]);

  useEffect(() => {
    if (!browserApi?.onCertError) return;
    return browserApi.onCertError((payload) => setCertBanner(payload.url));
  }, [browserApi]);

  useEffect(() => {
    if (!browserApi?.onDownload) return;
    return browserApi.onDownload((ev) => {
      setDownloads((prev) => {
        const i = prev.findIndex((d) => d.id === ev.id);
        if (i < 0) return [ev, ...prev].slice(0, 8);
        const next = [...prev];
        next[i] = ev;
        return next;
      });
    });
  }, [browserApi]);

  useEffect(() => {
    if (!showSuggestions) setActiveSuggest(-1);
  }, [showSuggestions]);

  useEffect(() => {
    if (!active || !browserApi || overlayOpen) return;
    syncBounds();
  }, [active, browserApi, overlayOpen, showSuggestions, findOpen, downloads.length, failBanner, syncBounds]);

  useEffect(() => {
    if (!overlayOpen) {
      snapshotForOverlayRef.current = null;
      setPageSnapshot(null);
      return;
    }
    if (snapshotForOverlayRef.current) {
      setPageSnapshot(snapshotForOverlayRef.current);
      return;
    }
    let cancelled = false;
    const run = async () => {
      if (!browserApi) return;
      const bounds = hostRef.current
        ? roundBounds(hostRef.current.getBoundingClientRect())
        : null;
      // Atomic main-process path avoids racing show/hide from parallel effects.
      if (browserApi.captureForOverlay) {
        const res = await browserApi.captureForOverlay(bounds);
        if (cancelled) return;
        if (res.ok && res.dataUrl) {
          snapshotForOverlayRef.current = res.dataUrl;
          setPageSnapshot(res.dataUrl);
        }
        return;
      }
      if (bounds && browserApi.show) await browserApi.show(bounds);
      const res = await browserApi.capture?.();
      if (cancelled) return;
      if (res?.ok && res.dataUrl) {
        snapshotForOverlayRef.current = res.dataUrl;
        setPageSnapshot(res.dataUrl);
      }
      await browserApi.hide?.();
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [overlayOpen, browserApi]);

  useEffect(() => {
    if (!active || !browserApi || !hostRef.current) return;
    if (overlayOpen) {
      // captureForOverlay already hides; keep BrowserView detached while overlay is open.
      return;
    }
    const el = hostRef.current;
    const bounds = roundBounds(el.getBoundingClientRect());
    let cancelled = false;
    const run = async () => {
      // Bind tab set to chat before show — avoids parking another chat's tabs into a blank workspace.
      if (workspaceChatId && browserApi.setWorkspace) {
        await browserApi.setWorkspace(workspaceChatId);
      }
      if (cancelled) return;
      await browserApi.show(bounds);
      if (!cancelled) syncBounds();
    };
    void run();
    const ro = new ResizeObserver(() => syncBounds());
    ro.observe(el);
    window.addEventListener("resize", syncBounds);
    return () => {
      cancelled = true;
      ro.disconnect();
      window.removeEventListener("resize", syncBounds);
      // Critical: unmount / overlay / leaving web must detach BrowserView.
      // Without this, Windows keeps a native view over the chat composer after surface switch.
      void browserApi.hide();
    };
  }, [active, browserApi, syncBounds, overlayOpen, workspaceChatId]);

  useEffect(() => {
    if (active) return;
    if (!browserApi) return;
    // hide() restores shell focus on Windows; keep an explicit restore after for races.
    void browserApi.hide().then(() => browserApi.restoreShellFocus?.());
  }, [active, browserApi]);

  // Last-resort detach if the component unmounts while still active (webSplit → chat).
  useEffect(() => {
    return () => {
      void window.claw2Desktop?.browser?.hide?.();
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === "f") {
        e.preventDefault();
        setFindOpen(true);
      }
      if (meta && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        void browserApi?.adjustZoom(0.1);
      }
      if (meta && e.key === "-") {
        e.preventDefault();
        void browserApi?.adjustZoom(-0.1);
      }
      if (meta && e.key === "0") {
        e.preventDefault();
        void browserApi?.setZoom(1);
      }
      if (meta && e.key === "p") {
        e.preventDefault();
        void browserApi?.print();
      }
      if (meta && e.key === "t") {
        e.preventDefault();
        void browserApi?.createTab("about:blank");
      }
      if (meta && e.key === "w") {
        e.preventDefault();
        if (activeTabId) void browserApi?.closeTab(activeTabId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, browserApi, activeTabId]);

  const navigateTo = useCallback(
    (raw: string, opts?: { allowSearchFallback?: boolean }) => {
      if (!browserApi) return;
      const next = raw.trim();
      if (!next) return;
      setSuggestOpen(false);
      setActiveSuggest(-1);
      setFailBanner(null);
      setCertBanner(null);
      urlInputRef.current?.blur();
      void browserApi.navigate(next, opts).then((res) => {
        if (res.ok && res.url) {
          setUrlDraft(res.url);
          setUrlHistory(recordUrlVisit(res.url, ""));
        }
      });
    },
    [browserApi]
  );

  const submitUrl = useCallback(() => {
    if (activeSuggest >= 0 && activeSuggest < suggestions.length) {
      navigateTo(suggestions[activeSuggest]!.url);
      return;
    }
    const raw = urlDraft.trim();
    if (!raw) return;
    if (looksLikeUrlOrHost(raw)) {
      navigateTo(raw);
      return;
    }
    if (onAddressSearch) {
      void onAddressSearch(raw);
      setSuggestOpen(false);
      urlInputRef.current?.blur();
      return;
    }
    navigateTo(duckDuckGoUrl(raw));
  }, [activeSuggest, navigateTo, onAddressSearch, suggestions, urlDraft]);

  const onUrlKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setSuggestOpen(false);
        setActiveSuggest(-1);
        return;
      }
      if (!showSuggestions) {
        if (e.key === "ArrowDown" && suggestions.length > 0) {
          e.preventDefault();
          setSuggestOpen(true);
          setActiveSuggest(0);
        }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveSuggest((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveSuggest((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && e.shiftKey && activeSuggest >= 0) {
        e.preventDefault();
        const entry = suggestions[activeSuggest];
        if (!entry) return;
        setUrlHistory(removeUrlHistoryEntry(entry.url));
      }
    },
    [activeSuggest, showSuggestions, suggestions]
  );

  const openOverlayLink = useCallback(
    (href: string) => {
      const url = href.trim();
      if (!url || url.startsWith("#") || url.toLowerCase().startsWith("javascript:")) return;
      // Never navigate the current tab — search/chat overlay links always open a new one.
      if (onOpenOverlayLink) {
        onOpenOverlayLink(url);
        return;
      }
      if (browserApi?.createTab) {
        void browserApi.createTab(url);
        return;
      }
    },
    [browserApi, onOpenOverlayLink]
  );

  const closeUrlCtxMenu = useCallback(() => {
    setUrlCtxMenu((prev) => {
      if (prev) void revealBrowserViewAfterMenu();
      return null;
    });
  }, []);

  const openUrlBarMenu = useCallback(
    (e: MouseEvent<HTMLInputElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const input = urlInputRef.current;
      if (!input || input.disabled) return;
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? 0;
      const selected = end > start ? urlDraft.slice(start, end) : "";
      const hasSelection = selected.length > 0;
      const hasText = urlDraft.length > 0;
      const rect = input.getBoundingClientRect();

      const applyEdit = (next: string, caret: number) => {
        setUrlDraft(next);
        setSuggestOpen(true);
        setUrlFocused(true);
        requestAnimationFrame(() => {
          const el = urlInputRef.current;
          if (!el) return;
          el.focus();
          const c = Math.max(0, Math.min(caret, next.length));
          el.setSelectionRange(c, c);
        });
      };

      const items: ContextMenuItem[] = [
        {
          type: "item",
          id: "url-cut",
          label: t("common.cut"),
          disabled: !hasSelection,
          onClick: () => {
            const s = input.selectionStart ?? 0;
            const en = input.selectionEnd ?? 0;
            const chunk = urlDraft.slice(s, en);
            void writeClipboard(chunk).then((ok) => {
              if (!ok) return;
              applyEdit(urlDraft.slice(0, s) + urlDraft.slice(en), s);
            });
          },
        },
        {
          type: "item",
          id: "url-copy",
          label: t("common.copy"),
          disabled: !hasSelection,
          onClick: () => {
            void writeClipboard(selected);
          },
        },
        {
          type: "item",
          id: "url-paste",
          label: t("common.paste"),
          onClick: () => {
            const s = input.selectionStart ?? 0;
            const en = input.selectionEnd ?? 0;
            void readClipboard().then((text) => {
              if (!text) return;
              applyEdit(urlDraft.slice(0, s) + text + urlDraft.slice(en), s + text.length);
            });
          },
        },
        {
          type: "item",
          id: "url-paste-go",
          label: t("browser.pasteAndGo"),
          onClick: () => {
            void readClipboard().then((text) => {
              const next = text.trim();
              if (!next) return;
              setUrlDraft(next);
              setActiveSuggest(-1);
              setSuggestOpen(false);
              if (looksLikeUrlOrHost(next)) {
                navigateTo(next);
              } else if (onAddressSearch) {
                void onAddressSearch(next);
                urlInputRef.current?.blur();
              } else {
                navigateTo(duckDuckGoUrl(next));
              }
            });
          },
        },
        {
          type: "item",
          id: "url-select-all",
          label: t("common.selectAll"),
          disabled: !hasText,
          onClick: () => {
            input.focus();
            input.setSelectionRange(0, urlDraft.length);
          },
        },
        { type: "separator", id: "url-sep" },
        {
          type: "item",
          id: "url-clear",
          label: t("common.clear"),
          disabled: !hasText,
          onClick: () => applyEdit("", 0),
        },
      ];

      const nextMenu: ContextMenuState = {
        x: e.clientX,
        y: rect.bottom + 4,
        items,
        preferUp: false,
      };
      setOverlayCtxMenu(null);
      void concealBrowserViewForMenu().finally(() => setUrlCtxMenu(nextMenu));
    },
    [navigateTo, onAddressSearch, t, urlDraft]
  );

  /** Original link actions + new message actions (do not replace the former). */
  const openOverlayMessageMenu = useCallback(
    (e: MouseEvent<HTMLElement>, msgEl: HTMLElement, plainRaw: string) => {
      e.preventDefault();
      e.stopPropagation();
      const bodyEl = msgEl.querySelector(".chat-msg-body") as HTMLElement | null;
      const selected = selectionTextIn(msgEl).trim();
      const plain = plainRaw.trim();
      const a = (e.target as Element | null)?.closest?.("a");
      const hrefRaw = a?.getAttribute("href")?.trim() || "";
      const linkHref =
        hrefRaw && !hrefRaw.startsWith("#") && !hrefRaw.toLowerCase().startsWith("javascript:")
          ? hrefRaw
          : "";

      const items: ContextMenuItem[] = [];

      // ——— original: Ask assistant on selection (same as BrowserView page menu) ———
      if (selected) {
        items.push({
          type: "item",
          id: "ov-ask",
          label: t("browser.askAssistant"),
          onClick: () => {
            window.dispatchEvent(
              new CustomEvent("claw2:ask-selection", {
                detail: {
                  text: selected,
                  url: nav.url || undefined,
                  title: nav.title || undefined,
                },
              })
            );
          },
        });
        items.push({ type: "separator", id: "ov-sep-ask" });
      }

      // ——— original W overlay link menu ———
      if (linkHref) {
        items.push({
          type: "item",
          id: "ov-open-tab",
          label: t("browser.openInNewTab"),
          onClick: () => openOverlayLink(linkHref),
        });
        items.push({
          type: "item",
          id: "ov-copy-link",
          label: t("browser.copyLink"),
          onClick: () => {
            void writeClipboard(linkHref);
          },
        });
        items.push({
          type: "item",
          id: "ov-save-link",
          label: t("browser.saveLinkAs"),
          onClick: () => {
            void browserApi?.downloadUrl?.(linkHref);
          },
        });
        items.push({ type: "separator", id: "ov-sep-link" });
      }

      // ——— new message actions ———
      if (selected) {
        items.push({
          type: "item",
          id: "ov-copy-sel",
          label: t("chat.ctxCopySelection"),
          onClick: () => {
            void writeClipboard(selected);
          },
        });
      }
      items.push({
        type: "item",
        id: "ov-copy-msg",
        label: t("chat.ctxCopyMessage"),
        disabled: !plain,
        onClick: () => {
          void writeClipboard(plain);
        },
      });
      items.push({
        type: "item",
        id: "ov-select-msg",
        label: t("chat.ctxSelectMessage"),
        disabled: !bodyEl,
        onClick: () => {
          if (!bodyEl) return;
          const range = document.createRange();
          range.selectNodeContents(bodyEl);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        },
      });
      items.push({
        type: "item",
        id: "ov-quote",
        label: t("chat.ctxQuote"),
        disabled: !(selected || plain),
        onClick: () => {
          const src = selected || plain;
          const quoted = src
            .split(/\r?\n/)
            .map((line) => `> ${line}`)
            .join("\n");
          window.dispatchEvent(new CustomEvent("claw2:quote-composer", { detail: { text: quoted } }));
        },
      });

      if (items.length === 0) return;
      setOverlayCtxMenu({ x: e.clientX, y: e.clientY, items });
    },
    [browserApi, nav.title, nav.url, openOverlayLink, t]
  );

  // Capture-phase: markdown/rehype can miss custom `a` handlers; never allow default nav.
  useEffect(() => {
    if (!overlayOpen) return;
    const root = overlayScrollRef.current;
    if (!root) return;
    const onClick = (e: Event) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const a = target.closest("a");
      if (!a || !root.contains(a)) return;
      const href = a.getAttribute("href");
      if (!href) return;
      e.preventDefault();
      e.stopPropagation();
      openOverlayLink(href);
    };
    root.addEventListener("click", onClick, true);
    return () => {
      root.removeEventListener("click", onClick, true);
    };
  }, [overlayOpen, openOverlayLink]);

  useEffect(() => {
    if (!overlayOpen) {
      setOverlayCtxMenu(null);
      setTonePanelOpen(false);
      return;
    }
    // Overlay owns BrowserView visibility — just dismiss the URL menu.
    setUrlCtxMenu(null);
    setTonePanelOpen(false);
  }, [overlayOpen]);

  useEffect(() => {
    if (!tonePanelOpen) return;
    const onPointer = (ev: PointerEvent) => {
      const root = toneWrapRef.current;
      if (root && !root.contains(ev.target as Node)) setTonePanelOpen(false);
    };
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key === "Escape") setTonePanelOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [tonePanelOpen]);

  const setOverlayTonePersisted = useCallback((value: number) => {
    const next = Math.min(100, Math.max(0, Math.round(value)));
    setOverlayTone(next);
    writeOverlayTone(next);
  }, []);

  const overlayComponents = useMemo(() => {
    const base = markdownComponents;
    return {
      ...base,
      a: ({
        href,
        children,
        node: _node,
        ...rest
      }: {
        href?: string;
        children?: ReactNode;
        node?: unknown;
      }) => (
        <a
          {...rest}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e: MouseEvent<HTMLAnchorElement>) => {
            e.preventDefault();
            e.stopPropagation();
            if (!href) return;
            openOverlayLink(href);
          }}
        >
          {children}
        </a>
      ),
    };
  }, [openOverlayLink]);

  const refreshSiteInfo = useCallback(async () => {
    if (!browserApi?.getSiteInfo) return;
    const info = await browserApi.getSiteInfo();
    setSiteInfo(info);
  }, [browserApi]);

  return (
    <div className="browser-surface">
      <div className="browser-tabstrip" role="tablist" aria-label={t("browser.tabs")}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === activeTabId}
            className={`browser-tab${tab.id === activeTabId ? " browser-tab--active" : ""}`}
            onClick={() => void browserApi?.switchTab(tab.id)}
            title={tab.url || tab.title}
          >
            <span className="browser-tab-title">{tab.title || t("browser.newTab")}</span>
            <span
              className="browser-tab-close"
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                void browserApi?.closeTab(tab.id);
              }}
              aria-label={t("browser.closeTab")}
            >
              <IconClose />
            </span>
          </button>
        ))}
        <button
          type="button"
          className="browser-tab-new"
          onClick={() => void browserApi?.createTab("about:blank")}
          aria-label={t("browser.newTab")}
          title={t("browser.newTab")}
          disabled={!hasDesktopBrowser}
        >
          <IconPlus />
        </button>
      </div>

      <div className="browser-chrome">
        <div className="browser-chrome-nav">
          <button type="button" className="browser-chrome-btn" disabled={!hasDesktopBrowser || !nav.canGoBack} onClick={() => void browserApi?.goBack()} aria-label={t("browser.back")} title={t("browser.back")}>
            <IconNavBack />
          </button>
          <button type="button" className="browser-chrome-btn" disabled={!hasDesktopBrowser || !nav.canGoForward} onClick={() => void browserApi?.goForward()} aria-label={t("browser.forward")} title={t("browser.forward")}>
            <IconNavForward />
          </button>
          {nav.isLoading ? (
            <button type="button" className="browser-chrome-btn" disabled={!hasDesktopBrowser} onClick={() => void browserApi?.stop()} aria-label={t("browser.stop")} title={t("browser.stop")}>
              <IconNavStop />
            </button>
          ) : (
            <button type="button" className="browser-chrome-btn" disabled={!hasDesktopBrowser} onClick={() => void browserApi?.reload()} aria-label={t("browser.reload")} title={t("browser.reload")}>
              <IconNavReload />
            </button>
          )}
          <button type="button" className="browser-chrome-btn" disabled={!hasDesktopBrowser} onClick={() => void browserApi?.createTab("about:blank")} aria-label={t("browser.home")} title={t("browser.home")}>
            <IconHome />
          </button>
        </div>
        <form
          className="browser-chrome-url"
          onSubmit={(e) => {
            e.preventDefault();
            submitUrl();
          }}
        >
          <button
            type="button"
            className={`browser-chrome-lock${nav.secure ? " browser-chrome-lock--ok" : ""}${nav.certError ? " browser-chrome-lock--bad" : ""}`}
            disabled={!hasDesktopBrowser}
            onClick={() => {
              setSiteInfoOpen((v) => !v);
              void refreshSiteInfo();
            }}
            aria-label={t("browser.siteInfo")}
            title={t("browser.siteInfo")}
          >
            <IconLock open={!nav.secure} />
          </button>
          <input
            ref={urlInputRef}
            className="browser-chrome-url-input"
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showSuggestions}
            aria-controls="browser-url-suggestions"
            aria-activedescendant={activeSuggest >= 0 ? `browser-url-suggestion-${activeSuggest}` : undefined}
            value={urlDraft}
            onChange={(e) => {
              setUrlDraft(e.target.value);
              setSuggestOpen(true);
              setActiveSuggest(-1);
            }}
            onFocus={() => {
              setUrlFocused(true);
              setSuggestOpen(true);
              requestAnimationFrame(() => urlInputRef.current?.select());
            }}
            onBlur={() => {
              window.setTimeout(() => {
                setUrlFocused(false);
                setSuggestOpen(false);
                setActiveSuggest(-1);
              }, 120);
            }}
            onKeyDown={onUrlKeyDown}
            onContextMenu={openUrlBarMenu}
            placeholder={t("browser.urlPlaceholder")}
            disabled={!hasDesktopBrowser}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
          />
          <button
            type="button"
            className={`browser-chrome-btn browser-chrome-star${starred ? " browser-chrome-star--on" : ""}`}
            disabled={!hasDesktopBrowser || !nav.url || nav.url === "about:blank"}
            onClick={() => setBookmarks(toggleBookmark(nav.url || "", nav.title || ""))}
            aria-label={t("browser.bookmark")}
            title={t("browser.bookmark")}
          >
            <IconStar filled={starred} />
          </button>
        </form>
        <div className="browser-chrome-extra">
          <button type="button" className="browser-chrome-btn" disabled={!hasDesktopBrowser} onClick={() => setBookmarksOpen((v) => !v)} aria-label={t("browser.bookmarks")} title={t("browser.bookmarks")}>
            <IconBookmarks />
          </button>
          <button type="button" className="browser-chrome-btn" disabled={!hasDesktopBrowser} onClick={() => setFindOpen(true)} aria-label={t("browser.find")} title={t("browser.find")}>
            <IconFind />
          </button>
          <button type="button" className="browser-chrome-btn" disabled={!hasDesktopBrowser} onClick={() => void browserApi?.print()} aria-label={t("browser.print")} title={t("browser.print")}>
            <IconPrint />
          </button>
          <button type="button" className="browser-chrome-btn" disabled={!hasDesktopBrowser} onClick={() => void browserApi?.adjustZoom(-0.1)} aria-label={t("browser.zoomOut")} title={t("browser.zoomOut")}>
            <IconZoomOut />
          </button>
          <button type="button" className="browser-chrome-btn browser-chrome-zoom-label" disabled={!hasDesktopBrowser} onClick={() => void browserApi?.setZoom(1)} aria-label={t("browser.zoomReset")} title={`${Math.round((nav.zoomFactor || 1) * 100)}%`}>
            {Math.round((nav.zoomFactor || 1) * 100)}%
          </button>
          <button type="button" className="browser-chrome-btn" disabled={!hasDesktopBrowser} onClick={() => void browserApi?.adjustZoom(0.1)} aria-label={t("browser.zoomIn")} title={t("browser.zoomIn")}>
            <IconZoomIn />
          </button>
        </div>
      </div>

      {siteInfoOpen && siteInfo?.ok ? (
        <div className="browser-site-info">
          <div className="browser-site-info-row">
            <strong>{siteInfo.secure ? t("browser.connectionSecure") : t("browser.connectionInsecure")}</strong>
            <span>{siteInfo.origin || siteInfo.url}</span>
          </div>
          {siteInfo.certError ? (
            <button type="button" className="browser-site-info-btn" onClick={() => void browserApi?.proceedInsecure(siteInfo.url)}>
              {t("browser.proceedInsecure")}
            </button>
          ) : null}
          <p className="browser-site-info-hint">{t("browser.passwordsHint")}</p>
          {(siteInfo.permissions || []).length > 0 ? (
            <ul className="browser-site-info-perms">
              {siteInfo.permissions!.map((p) => (
                <li key={p.permission}>
                  {p.permission}: {p.allow ? t("browser.permAllow") : t("browser.permDeny")}
                </li>
              ))}
            </ul>
          ) : (
            <p className="browser-site-info-hint">{t("browser.noPermissions")}</p>
          )}
          <button
            type="button"
            className="browser-site-info-btn"
            onClick={() => {
              if (siteInfo.origin) void browserApi?.clearSiteData(siteInfo.origin);
              setSiteInfoOpen(false);
            }}
          >
            {t("browser.clearSiteData")}
          </button>
        </div>
      ) : null}

      {bookmarksOpen ? (
        <ul className="browser-bookmarks-panel" aria-label={t("browser.bookmarks")}>
          {bookmarks.length === 0 ? <li className="browser-bookmarks-empty">{t("browser.bookmarksEmpty")}</li> : null}
          {bookmarks.map((b) => (
            <li key={b.url}>
              <button type="button" className="browser-bookmark-item" onClick={() => { navigateTo(b.url); setBookmarksOpen(false); }}>
                <span>{b.title}</span>
                <span className="browser-bookmark-url">{displayUrl(b.url)}</span>
              </button>
              <button type="button" className="browser-bookmark-open-tab" onClick={() => void browserApi?.createTab(b.url)} title={t("browser.openInNewTab")}>
                ↗
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {findOpen ? (
        <div className="browser-find-bar">
          <input
            autoFocus
            value={findQuery}
            onChange={(e) => {
              setFindQuery(e.target.value);
              void browserApi?.findInPage(e.target.value, { findNext: false });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void browserApi?.findInPage(findQuery, { findNext: true, forward: !e.shiftKey });
              }
              if (e.key === "Escape") {
                setFindOpen(false);
                void browserApi?.stopFindInPage();
              }
            }}
            placeholder={t("browser.findPlaceholder")}
          />
          <button type="button" onClick={() => void browserApi?.findInPage(findQuery, { findNext: true, forward: false })}>
            ↑
          </button>
          <button type="button" onClick={() => void browserApi?.findInPage(findQuery, { findNext: true, forward: true })}>
            ↓
          </button>
          <button
            type="button"
            onClick={() => {
              setFindOpen(false);
              void browserApi?.stopFindInPage();
            }}
          >
            <IconClose size={14} />
          </button>
        </div>
      ) : null}

      {showSuggestions ? (
        <ul id="browser-url-suggestions" className="browser-url-suggestions" role="listbox" aria-label={t("browser.urlSuggestions")}>
          {suggestions.map((entry, i) => {
            const title = entry.title.trim() || displayUrl(entry.url);
            return (
              <li key={entry.url} role="presentation">
                <button
                  type="button"
                  id={`browser-url-suggestion-${i}`}
                  role="option"
                  aria-selected={i === activeSuggest}
                  className={`browser-url-suggestion${i === activeSuggest ? " browser-url-suggestion--active" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    navigateTo(entry.url);
                  }}
                  onMouseEnter={() => setActiveSuggest(i)}
                  title={t("browser.urlSuggestionHint")}
                >
                  <span className="browser-url-suggestion-title">{title}</span>
                  <span className="browser-url-suggestion-url">{displayUrl(entry.url)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {failBanner ? (
        <div className="browser-fail-banner" role="alert">
          <span>{t("browser.loadFailed", { detail: failBanner.errorDescription || String(failBanner.errorCode) })}</span>
          <button type="button" onClick={() => { setFailBanner(null); void browserApi?.reload(); }}>
            {t("browser.retry")}
          </button>
        </div>
      ) : null}
      {certBanner ? (
        <div className="browser-fail-banner browser-fail-banner--cert" role="alert">
          <span>{t("browser.certError")}</span>
          <button type="button" onClick={() => { void browserApi?.proceedInsecure(certBanner); setCertBanner(null); }}>
            {t("browser.proceedInsecure")}
          </button>
          <button type="button" onClick={() => setCertBanner(null)}>
            {t("common.close")}
          </button>
        </div>
      ) : null}

      {downloads.length > 0 ? (
        <div className="browser-downloads">
          {downloads.map((d) => (
            <div key={d.id} className="browser-download-row">
              <span className="browser-download-name">{d.filename}</span>
              <span className="browser-download-state">
                {d.state === "progressing" && d.total > 0
                  ? `${Math.round((d.received / d.total) * 100)}%`
                  : d.state}
              </span>
              {d.savePath && (d.state === "completed" || d.state === "interrupted") ? (
                <button type="button" onClick={() => void browserApi?.showItemInFolder(d.savePath!)}>
                  {t("browser.showInFolder")}
                </button>
              ) : null}
              <button type="button" onClick={() => setDownloads((prev) => prev.filter((x) => x.id !== d.id))}>
                <IconClose size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="browser-view-host-wrap">
        {hasDesktopBrowser ? (
          <div ref={hostRef} className="browser-view-host" aria-label={t("browser.viewLabel")} />
        ) : (
          <div className="browser-desktop-only">
            <p>{t("browser.desktopOnly")}</p>
          </div>
        )}
        {overlayOpen ? (
          <div
            className={`browser-answer-overlay${pageSnapshot ? " browser-answer-overlay--glass" : ""}`}
            role="dialog"
            aria-label={t("browser.answerOverlay")}
            style={{ ["--overlay-tone" as string]: String(overlayTone / 100) }}
          >
            {pageSnapshot ? (
              <img className="browser-answer-overlay-snap" src={pageSnapshot} alt="" aria-hidden draggable={false} />
            ) : null}
            <div className="browser-answer-overlay-frost" aria-hidden />
            <div className="browser-answer-overlay-toolbar">
              <div className="browser-answer-overlay-tone-wrap" ref={toneWrapRef}>
                <button
                  type="button"
                  className="browser-answer-overlay-tone-btn"
                  aria-label={t("browser.overlayTone")}
                  title={t("browser.overlayTone")}
                  aria-expanded={tonePanelOpen}
                  aria-controls="browser-overlay-tone-panel"
                  onClick={() => setTonePanelOpen((v) => !v)}
                >
                  <IconBrightness size={18} />
                </button>
                {tonePanelOpen ? (
                  <div
                    id="browser-overlay-tone-panel"
                    className="browser-answer-overlay-tone-panel"
                    role="group"
                    aria-label={t("browser.overlayTone")}
                  >
                    <div className="browser-answer-overlay-tone-labels">
                      <span>{t("browser.overlayToneLighter")}</span>
                      <span>{t("browser.overlayToneDarker")}</span>
                    </div>
                    <input
                      type="range"
                      className="browser-answer-overlay-tone-slider"
                      min={0}
                      max={100}
                      step={1}
                      value={overlayTone}
                      onChange={(e) => setOverlayTonePersisted(Number(e.target.value))}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={overlayTone}
                      aria-label={t("browser.overlayTone")}
                    />
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="browser-answer-overlay-close"
                onClick={() => onCloseAnswerOverlay?.()}
                aria-label={t("browser.closeAnswer")}
                title={t("browser.closeAnswer")}
              >
                <IconOverlayClose size={20} />
              </button>
            </div>
            <div ref={overlayScrollRef} className="browser-answer-overlay-scroll">
              <div className="browser-answer-overlay-thread chat-log">
                {(answerOverlay!.messages ?? []).map((msg, i) => {
                  if (msg.role === "visit_marker") {
                    const label = formatVisitMarkerLabel(
                      msg.at || msg.content,
                      typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ru")
                        ? "ru"
                        : "en",
                      msg.content
                    );
                    return (
                      <div key={`visit-${i}`} className="chat-visit-marker" role="separator">
                        <span>{label}</span>
                      </div>
                    );
                  }
                  const isLastAssistant =
                    msg.role === "assistant" && i === answerOverlay!.messages.length - 1;
                  if (msg.role === "assistant") {
                    const display = resolveAssistantDisplay({
                      content: msg.content,
                      cells: msg.cells,
                    });
                    const body = display.content.trim()
                      ? display.content
                      : answerOverlay!.streaming
                        ? "…"
                        : "";
                    if (!body && display.cells.length === 0 && !answerOverlay!.streaming) return null;
                    return (
                      <div
                        key={`${msg.role}-${i}`}
                        className={`chat-msg chat-msg--${msg.role}`}
                        onContextMenu={(e) => {
                          openOverlayMessageMenu(
                            e,
                            e.currentTarget,
                            markdownToPlainText(display.content || msg.content || "")
                          );
                        }}
                      >
                        <span className="chat-msg-label">{t("common.agent")}: </span>
                        <div className="chat-msg-body">
                          <div
                            className={`chat-msg-content${
                              display.cells.length > 0 ? " chat-msg-content--with-cells" : ""
                            }`}
                          >
                            {display.cells.length > 0 ? (
                              renderCellSegments(
                                display.content,
                                display.cells,
                                (text, key) =>
                                  text.trim() && text !== "…" ? (
                                    <span key={key} className="chat-msg-markdown-wrap">
                                      <div className="chat-msg-markdown-wrapper">
                                        <ReactMarkdown
                                          remarkPlugins={[remarkGfm]}
                                          rehypePlugins={[[rehypeSanitize, overlaySanitizeSchema]]}
                                          className="chat-msg-markdown"
                                          components={overlayComponents as typeof markdownComponents}
                                        >
                                          {text}
                                        </ReactMarkdown>
                                      </div>
                                    </span>
                                  ) : null,
                                (cell, _index, key) => <OverlayCell key={key} cell={cell} />
                              )
                            ) : body.trim() && body !== "…" ? (
                              <div className="chat-msg-markdown-wrapper">
                                <ReactMarkdown
                                  remarkPlugins={[remarkGfm]}
                                  rehypePlugins={[[rehypeSanitize, overlaySanitizeSchema]]}
                                  className="chat-msg-markdown"
                                  components={overlayComponents as typeof markdownComponents}
                                >
                                  {body}
                                </ReactMarkdown>
                              </div>
                            ) : (
                              <p className="browser-answer-overlay-pending">
                                {answerOverlay!.streaming ? (
                                  <ChatWorkingIndicator showLabel showCursor />
                                ) : null}
                              </p>
                            )}
                            {isLastAssistant &&
                            answerOverlay!.streaming &&
                            body.trim() &&
                            body !== "…" ? (
                              <ChatWorkingIndicator showLabel={false} showCursor />
                            ) : null}
                          </div>
                        </div>
                      </div>
                    );
                  }
                  const body = msg.content;
                  return (
                    <div
                      key={`${msg.role}-${i}`}
                      className={`chat-msg chat-msg--${msg.role}`}
                      onContextMenu={(e) => {
                        openOverlayMessageMenu(e, e.currentTarget, body || "");
                      }}
                    >
                      <span className="chat-msg-label">{t("common.you")}: </span>
                      <div className="chat-msg-body">
                        <div className="chat-msg-content">
                          <span className="chat-msg-content">{body}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <ContextMenu
              menu={overlayCtxMenu}
              onClose={() => setOverlayCtxMenu(null)}
              className="claw-context-menu--chat-log"
            />
          </div>
        ) : null}
      </div>

      <ContextMenu
        menu={urlCtxMenu}
        onClose={closeUrlCtxMenu}
        className="claw-context-menu--composer-web"
      />
    </div>
  );
}
