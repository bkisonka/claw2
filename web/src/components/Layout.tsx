// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useState, useCallback, useEffect, useRef } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { RuntimeDiedBanner } from "./RuntimeDiedBanner";
import type { ChatItem } from "../store/chatList";
import type { ProjectListItemApi } from "../api/project";
import { useT } from "../i18n";
import { IconMenu } from "./icons";

const SIDEBAR_WIDTH_KEY = "claw2.sidebarWidth";
const SIDEBAR_WIDTH_DEFAULT = 280;
const SIDEBAR_WIDTH_MIN = 220;
const SIDEBAR_WIDTH_MAX = 480;

function clampSidebarWidth(px: number, viewportW = typeof window !== "undefined" ? window.innerWidth : 1200): number {
  const maxByViewport = Math.floor(viewportW * 0.45);
  const max = Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, maxByViewport));
  return Math.round(Math.min(max, Math.max(SIDEBAR_WIDTH_MIN, px)));
}

function readStoredSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (!raw) return SIDEBAR_WIDTH_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return SIDEBAR_WIDTH_DEFAULT;
    return clampSidebarWidth(n);
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

function persistSidebarWidth(px: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(px));
  } catch {
    /* ignore */
  }
}

interface LayoutProps {
  chats: ChatItem[];
  projects: ProjectListItemApi[];
  currentChatId: string | null;
  onSelectChat: (id: string) => void;
  /** projectId === undefined | null — plain chat; otherwise a new chat in a project. */
  onNewChat: (projectId?: string | null) => void;
  onProjectCreated?: (project: ProjectListItemApi) => void;
  onProjectUpdated?: (project: ProjectListItemApi) => void;
  onDeleteProject?: (projectId: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  listLoading?: boolean;
  listError?: string | null;
  onDeleteChat?: (chatId: string) => void;
  onExportChat?: (chatId: string) => void;
  onExportClawCache?: (chatId: string) => void;
  onDuplicateChat?: (chatId: string, opts?: { upToCount?: number; title?: string }) => Promise<string | null>;
  onChatProjectChange?: (chatId: string, projectId: string | null) => void;
  onChatPinnedChange?: (chatId: string, pinned: boolean) => void;
  onChatFavoritedChange?: (chatId: string, favorited: boolean) => void;
  onDynamicPrompt?: (text: string) => void;
  sidebarRefreshKey?: number;
  mainSurface?: "chat" | "web";
  onToggleMainSurface?: () => void;
  streamingChatIds?: string[];
  attentionChatIds?: string[];
  children: ReactNode;
}

export function Layout({
  chats,
  projects,
  currentChatId,
  onSelectChat,
  onNewChat,
  onProjectCreated,
  onProjectUpdated,
  onDeleteProject,
  searchQuery,
  onSearchChange,
  listLoading,
  listError,
  onDeleteChat,
  onExportChat,
  onExportClawCache,
  onDuplicateChat,
  onChatProjectChange,
  onChatPinnedChange,
  onChatFavoritedChange,
  onDynamicPrompt,
  sidebarRefreshKey,
  mainSurface = "chat",
  onToggleMainSurface,
  streamingChatIds,
  attentionChatIds,
  children,
}: LayoutProps) {
  const t = useT();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_WIDTH_DEFAULT);
  const [resizing, setResizing] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const dragActive = useRef(false);

  useEffect(() => {
    setSidebarWidth(readStoredSidebarWidth());
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const onResize = () => {
      setSidebarWidth((w) => {
        const next = clampSidebarWidth(w);
        if (next !== w) persistSidebarWidth(next);
        return next;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const handleCloseSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  const endResize = useCallback(() => {
    if (!dragActive.current) return;
    dragActive.current = false;
    setResizing(false);
    document.body.classList.remove("layout-sidebar-resizing-body");
    setSidebarWidth((w) => {
      persistSidebarWidth(w);
      return w;
    });
  }, []);

  const onResizerPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragActive.current = true;
      setResizing(true);
      document.body.classList.add("layout-sidebar-resizing-body");
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        if (!dragActive.current) return;
        setSidebarWidth(clampSidebarWidth(ev.clientX));
      };
      const onUp = () => {
        target.releasePointerCapture(e.pointerId);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        endResize();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [endResize]
  );

  const onResizerDoubleClick = useCallback(() => {
    const next = clampSidebarWidth(SIDEBAR_WIDTH_DEFAULT);
    setSidebarWidth(next);
    persistSidebarWidth(next);
  }, []);

  const wrapStyle = {
    ["--sidebar-w" as string]: `${sidebarWidth}px`,
  } as CSSProperties;

  return (
    <div
      className={`layout-wrap${resizing ? " layout-sidebar-resizing" : ""}`}
      style={wrapStyle}
    >
      <RuntimeDiedBanner />
      <Sidebar
        open={sidebarOpen}
        chats={chats}
        projects={projects}
        currentChatId={currentChatId}
        onSelectChat={onSelectChat}
        onNewChat={onNewChat}
        onProjectCreated={onProjectCreated}
        onProjectUpdated={onProjectUpdated}
        onDeleteProject={onDeleteProject}
        searchQuery={searchQuery}
        onSearchChange={onSearchChange}
        listLoading={listLoading}
        listError={listError}
        onDeleteChat={onDeleteChat}
        onExportChat={onExportChat}
        onExportClawCache={onExportClawCache}
        onDuplicateChat={onDuplicateChat}
        onChatProjectChange={onChatProjectChange}
        onChatPinnedChange={onChatPinnedChange}
        onChatFavoritedChange={onChatFavoritedChange}
        onDynamicPrompt={onDynamicPrompt}
        sidebarRefreshKey={sidebarRefreshKey}
        mainSurface={mainSurface}
        onToggleMainSurface={onToggleMainSurface}
        streamingChatIds={streamingChatIds}
        attentionChatIds={attentionChatIds}
        onToggle={() => setSidebarOpen((v) => !v)}
        sidebarOpen={sidebarOpen}
      />
      {sidebarOpen && !narrow ? (
        <div
          className="layout-sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("common.resizeSidebar")}
          aria-valuenow={sidebarWidth}
          aria-valuemin={SIDEBAR_WIDTH_MIN}
          aria-valuemax={SIDEBAR_WIDTH_MAX}
          tabIndex={0}
          onPointerDown={onResizerPointerDown}
          onDoubleClick={onResizerDoubleClick}
        />
      ) : null}
      {!sidebarOpen ? (
        <button
          type="button"
          className="layout-sidebar-toggle layout-sidebar-toggle-floating"
          onClick={() => setSidebarOpen(true)}
          aria-label={t("common.openMenu")}
          aria-expanded={false}
        >
          <IconMenu size={18} />
        </button>
      ) : null}
      <div className={`layout-sidebar-backdrop ${sidebarOpen ? "layout-sidebar-backdrop-visible" : ""}`} onClick={handleCloseSidebar} aria-hidden />
      <main className="layout-main">
        {children}
      </main>
    </div>
  );
}
