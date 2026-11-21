// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import type { ProjectListItemApi } from "../api/project";
import { createProject, updateProject } from "../api/project";
import { fetchChatAssetsSummary } from "../api/chat";
import { fetchSidebar, clickSidebarItem, type DynamicSidebarItem, type DynamicSidebarState } from "../api/sidebar";
import { getConfig } from "../api/config";
import type { ChatItem } from "../store/chatList";
import { compareChatItems } from "../store/chatList";
import { useAuth } from "../context/AuthContext";
import { useT } from "../i18n";
import { restoreShellFocus } from "../desktop/shellFocus";
import {
  IconChat,
  IconChevron,
  IconDownload,
  IconEdit,
  IconFile,
  IconMore,
  IconMenu,
  IconPin,
  IconPlus,
  IconSearch,
  IconSettings,
  IconGlobe,
  IconSpark,
  IconStar,
  IconTrash,
  IconImage,
  IconPhone,
  IconSpinner,
  IconAlertDot,
  IconCheck,
  SidebarGlyphIcon,
} from "./icons";

function groupChatsByDate(chats: ChatItem[], t: ReturnType<typeof useT>): { label: string; items: ChatItem[] }[] {
  const day = 86_400_000;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart.getTime() - day);
  const weekStart = new Date(todayStart.getTime() - 7 * day);
  const pinned = chats.filter((c) => c.pinned).sort(compareChatItems);
  const today: ChatItem[] = [];
  const yesterday: ChatItem[] = [];
  const earlier: ChatItem[] = [];

  for (const chat of chats) {
    if (chat.pinned) continue;
    if (chat.updatedAt >= todayStart.getTime()) today.push(chat);
    else if (chat.updatedAt >= yesterdayStart.getTime()) yesterday.push(chat);
    else if (chat.updatedAt >= weekStart.getTime()) earlier.push(chat);
    else earlier.push(chat);
  }

  const groups: { label: string; items: ChatItem[] }[] = [];
  if (pinned.length) groups.push({ label: t("sidebar.pinned"), items: pinned });
  if (today.length) groups.push({ label: t("sidebar.today"), items: today });
  if (yesterday.length) groups.push({ label: t("sidebar.yesterday"), items: yesterday });
  if (earlier.length) groups.push({ label: t("sidebar.earlier"), items: earlier });
  return groups;
}

function chatsInProject(chats: ChatItem[], projectId: string): ChatItem[] {
  return chats.filter((chat) => chat.projectId === projectId).sort(compareChatItems);
}

interface SidebarProps {
  open?: boolean;
  chats: ChatItem[];
  projects: ProjectListItemApi[];
  currentChatId: string | null;
  onSelectChat: (id: string) => void;
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
  onChatProjectChange?: (chatId: string, projectId: string | null) => void;
  onChatPinnedChange?: (chatId: string, pinned: boolean) => void;
  onChatFavoritedChange?: (chatId: string, favorited: boolean) => void;
  onToggle?: () => void;
  sidebarOpen?: boolean;
  onDynamicPrompt?: (text: string) => void;
  sidebarRefreshKey?: number;
  /** chat = full chat; web = browse surface + chat drawer */
  mainSurface?: "chat" | "web";
  onToggleMainSurface?: () => void;
  /** Sessions with an in-flight model reply. */
  streamingChatIds?: string[];
  /** Sessions that finished while the user was elsewhere. */
  attentionChatIds?: string[];
}

export function Sidebar({
  open = true,
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
  onChatProjectChange,
  onChatPinnedChange,
  onChatFavoritedChange,
  onToggle,
  onDynamicPrompt,
  sidebarRefreshKey,
  mainSurface = "chat",
  onToggleMainSurface,
  streamingChatIds = [],
  attentionChatIds = [],
}: SidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const t = useT();
  const isCabinet = location.pathname.startsWith("/cabinet");
  const [dynamic, setDynamic] = useState<DynamicSidebarState>({ title: "", items: [], updatedAt: 0 });
  const [sipEnabled, setSipEnabled] = useState(false);
  const [hasGalleryImages, setHasGalleryImages] = useState(false);
  const [hasDocuments, setHasDocuments] = useState(false);
  const [pulseGallery, setPulseGallery] = useState(false);
  const [pulseDocuments, setPulseDocuments] = useState(false);
  const prevHasGalleryRef = useRef<boolean | null>(null);
  const prevHasDocumentsRef = useRef<boolean | null>(null);
  const skipAssetsPulseRef = useRef(true);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [addToProjectChatId, setAddToProjectChatId] = useState<string | null>(null);
  const [menuPlacement, setMenuPlacement] = useState<{
    top?: number;
    bottom?: number;
    right: number;
  } | null>(null);
  const [newChatMenuOpen, setNewChatMenuOpen] = useState(false);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(new Set());
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [projectError, setProjectError] = useState<string | null>(null);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [projectDescDraft, setProjectDescDraft] = useState("");
  const [savingProjectDesc, setSavingProjectDesc] = useState(false);
  const [projectDescError, setProjectDescError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuPanelRef = useRef<HTMLDivElement>(null);
  const menuAnchorRef = useRef<HTMLElement | null>(null);
  const newChatMenuRef = useRef<HTMLDivElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const ignoreOutsideClickRef = useRef(false);
  const displayName = user?.login || user?.email || "claw2";
  const initials = displayName.trim().slice(0, 1).toUpperCase();
  const avatarLetter = mainSurface === "web" ? "W" : initials;
  const webMode = mainSurface === "web";
  const globeTitle = webMode ? t("sidebar.chatMode") : t("sidebar.webMode");

  useEffect(() => {
    if (!currentChatId) {
      setDynamic({ title: "", items: [], updatedAt: 0 });
      return;
    }
    let cancelled = false;
    fetchSidebar(currentChatId)
      .then((state) => {
        if (!cancelled) setDynamic(state);
      })
      .catch(() => {
        if (!cancelled) setDynamic({ title: "", items: [], updatedAt: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, [currentChatId, sidebarRefreshKey]);

  useEffect(() => {
    skipAssetsPulseRef.current = true;
    prevHasGalleryRef.current = null;
    prevHasDocumentsRef.current = null;
    setPulseGallery(false);
    setPulseDocuments(false);
    setHasGalleryImages(false);
    setHasDocuments(false);
  }, [currentChatId]);

  useEffect(() => {
    if (!pulseGallery) return;
    const id = window.setTimeout(() => setPulseGallery(false), 3000);
    return () => window.clearTimeout(id);
  }, [pulseGallery]);

  useEffect(() => {
    if (!pulseDocuments) return;
    const id = window.setTimeout(() => setPulseDocuments(false), 3000);
    return () => window.clearTimeout(id);
  }, [pulseDocuments]);

  useEffect(() => {
    let cancelled = false;
    if (!currentChatId) {
      setHasGalleryImages(false);
      setHasDocuments(false);
      prevHasGalleryRef.current = false;
      prevHasDocumentsRef.current = false;
      return;
    }
    fetchChatAssetsSummary(currentChatId)
      .then((s) => {
        if (cancelled) return;
        const nextGallery = s.imageCount > 0;
        const nextDocs = s.documentCount > 0;
        const skipPulse = skipAssetsPulseRef.current;
        skipAssetsPulseRef.current = false;
        if (!skipPulse) {
          if (nextGallery && prevHasGalleryRef.current === false) setPulseGallery(true);
          if (nextDocs && prevHasDocumentsRef.current === false) setPulseDocuments(true);
        }
        prevHasGalleryRef.current = nextGallery;
        prevHasDocumentsRef.current = nextDocs;
        setHasGalleryImages(nextGallery);
        setHasDocuments(nextDocs);
      })
      .catch(() => {
        if (cancelled) return;
        skipAssetsPulseRef.current = false;
        prevHasGalleryRef.current = false;
        prevHasDocumentsRef.current = false;
        setHasGalleryImages(false);
        setHasDocuments(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentChatId, sidebarRefreshKey, chats]);

  useEffect(() => {
    let cancelled = false;
    getConfig()
      .then((cfg) => {
        if (cancelled) return;
        const sip = cfg.sip as { enabled?: boolean } | undefined;
        setSipEnabled(sip?.enabled === true);
      })
      .catch(() => {
        if (!cancelled) setSipEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sidebarRefreshKey, location.pathname]);

  useEffect(() => {
    if (!openMenuId) return;
    ignoreOutsideClickRef.current = true;
    const arm = window.setTimeout(() => {
      ignoreOutsideClickRef.current = false;
    }, 0);
    const close = (event: MouseEvent) => {
      if (ignoreOutsideClickRef.current) return;
      const target = event.target as Node;
      if (menuPanelRef.current?.contains(target)) return;
      if (menuAnchorRef.current?.contains(target)) return;
      setOpenMenuId(null);
      setAddToProjectChatId(null);
      setMenuPlacement(null);
      menuAnchorRef.current = null;
    };
    document.addEventListener("mousedown", close, true);
    return () => {
      window.clearTimeout(arm);
      document.removeEventListener("mousedown", close, true);
    };
  }, [openMenuId]);

  useEffect(() => {
    if (!newChatMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (newChatMenuRef.current && !newChatMenuRef.current.contains(event.target as Node)) setNewChatMenuOpen(false);
    };
    document.addEventListener("click", close, true);
    return () => document.removeEventListener("click", close, true);
  }, [newChatMenuOpen]);

  useEffect(() => {
    if (!projectFormOpen) return;
    projectInputRef.current?.focus();
  }, [projectFormOpen]);

  const handleNewChat = (projectId?: string | null) => {
    if (isCabinet) navigate("/chat");
    if (projectId) {
      setExpandedProjectIds((previous) => new Set(previous).add(projectId));
    }
    onNewChat(projectId);
    setNewChatMenuOpen(false);
  };

  const handleSelectChat = (id: string) => {
    if (isCabinet) navigate("/chat");
    onSelectChat(id);
  };

  const handleCreateProject = async () => {
    const name = projectNameDraft.trim();
    if (!name) {
      setProjectError(t("sidebar.projectNamePlaceholder"));
      return;
    }
    setCreatingProject(true);
    setProjectError(null);
    try {
      onProjectCreated?.(await createProject(name));
      setProjectNameDraft("");
      setProjectFormOpen(false);
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingProject(false);
    }
  };

  const openProjectGoalEditor = (project: ProjectListItemApi) => {
    setEditingProjectId(project.id);
    setProjectDescDraft(project.description ?? "");
    setProjectDescError(null);
    setExpandedProjectIds((prev) => new Set(prev).add(project.id));
  };

  const handleSaveProjectGoal = async () => {
    if (!editingProjectId) return;
    setSavingProjectDesc(true);
    setProjectDescError(null);
    try {
      const updated = await updateProject(editingProjectId, {
        description: projectDescDraft,
      });
      onProjectUpdated?.(updated);
      setEditingProjectId(null);
      setProjectDescDraft("");
    } catch (err) {
      setProjectDescError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingProjectDesc(false);
    }
  };

  const toggleProject = (id: string) => {
    setExpandedProjectIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const dynamicClickLock = useRef(false);

  const handleDynamicItem = async (item: DynamicSidebarItem) => {
    if (dynamicClickLock.current) return;
    dynamicClickLock.current = true;
    const sid = currentChatId || "";
    if (!sid) {
      dynamicClickLock.current = false;
      return;
    }
    try {
      const next = await clickSidebarItem(sid, item.id);
      setDynamic(next);
    } catch {
      // Stale item (removed mid-turn): refresh and do not fire the local action.
      try {
        setDynamic(await fetchSidebar(sid));
      } catch {
        setDynamic({ title: "", items: [], updatedAt: 0 });
      }
      dynamicClickLock.current = false;
      return;
    }
    try {
      if (item.action === "prompt") onDynamicPrompt?.(item.value);
      else if (item.action === "navigate") navigate(item.value);
      else window.open(item.value, "_blank", "noopener,noreferrer");
    } finally {
      dynamicClickLock.current = false;
    }
  };

  const closeMenu = () => {
    setOpenMenuId(null);
    setAddToProjectChatId(null);
    setMenuPlacement(null);
    menuAnchorRef.current = null;
  };

  const toggleChatMenu = (chatId: string, anchor: HTMLElement) => {
    if (openMenuId === chatId) {
      closeMenu();
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const approxMenuH = 300;
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < approxMenuH && rect.top > spaceBelow;
    const right = Math.max(8, window.innerWidth - rect.right);
    menuAnchorRef.current = anchor;
    setMenuPlacement(
      openUp
        ? { bottom: window.innerHeight - rect.top + 4, right }
        : { top: rect.bottom + 4, right }
    );
    setAddToProjectChatId(null);
    setOpenMenuId(chatId);
  };

  const renderChatMenu = (chat: ChatItem) => {
    if (!menuPlacement) return null;
    const inProject = Boolean(chat.projectId);
    const handleRemoveFromProject = () => {
      const projectId = chat.projectId;
      if (!projectId) return;
      const project = projects.find((p) => p.id === projectId);
      const isLastInProject =
        chats.filter((c) => c.projectId === projectId).length <= 1;
      onChatProjectChange?.(chat.id, null);
      closeMenu();
      if (
        isLastInProject &&
        project &&
        onDeleteProject &&
        window.confirm(t("sidebar.deleteEmptyProjectConfirm", { name: project.name }))
      ) {
        onDeleteProject(project.id);
      }
    };
    const isFavorited = !!chat.favorited;
    const isPinned = !!chat.pinned;
    return createPortal(
      <div
        ref={menuPanelRef}
        className="layout-sidebar-chat-item-menu layout-sidebar-chat-item-menu--fixed"
        style={{
          top: menuPlacement.top,
          bottom: menuPlacement.bottom,
          right: menuPlacement.right,
        }}
        role="menu"
      >
        <button
          type="button"
          className="layout-sidebar-chat-item-menu-btn"
          role="menuitem"
          onClick={() => {
            onChatFavoritedChange?.(chat.id, !isFavorited);
            closeMenu();
          }}
        >
          <span className="layout-sidebar-chat-item-menu-icon shell-nav-ico" aria-hidden>
            <IconStar filled={isFavorited} />
          </span>
          {isFavorited ? t("sidebar.unfavorite") : t("sidebar.favorite")}
        </button>
        <button
          type="button"
          className="layout-sidebar-chat-item-menu-btn"
          role="menuitem"
          onClick={() => {
            onChatPinnedChange?.(chat.id, !isPinned);
            closeMenu();
          }}
        >
          <span className="layout-sidebar-chat-item-menu-icon shell-nav-ico" aria-hidden>
            <IconPin filled={isPinned} />
          </span>
          {isPinned ? t("sidebar.unpin") : t("sidebar.pin")}
        </button>
        <button type="button" className="layout-sidebar-chat-item-menu-btn" role="menuitem" onClick={() => { onExportChat?.(chat.id); closeMenu(); }}>
          <span className="layout-sidebar-chat-item-menu-icon shell-nav-ico" aria-hidden><IconDownload /></span>
          {t("sidebar.exportMd")}
        </button>
        <button type="button" className="layout-sidebar-chat-item-menu-btn" role="menuitem" onClick={() => { onExportClawCache?.(chat.id); closeMenu(); }}>
          <span className="layout-sidebar-chat-item-menu-icon shell-nav-ico" aria-hidden><SidebarGlyphIcon name="file" /></span>
          {t("sidebar.exportClawCache")}
        </button>
        {inProject ? (
          <button
            type="button"
            className="layout-sidebar-chat-item-menu-btn"
            role="menuitem"
            onClick={handleRemoveFromProject}
          >
            {t("sidebar.removeFromProject")}
          </button>
        ) : (
          <div className="layout-sidebar-chat-item-menu-subwrap">
            <button
              type="button"
              className="layout-sidebar-chat-item-menu-btn layout-sidebar-chat-item-menu-btn-sub"
              onClick={() => setAddToProjectChatId((id) => (id === chat.id ? null : chat.id))}
              aria-expanded={addToProjectChatId === chat.id}
              disabled={projects.length === 0}
            >
              {t("sidebar.addToProject")}
              <span className="layout-sidebar-chat-item-menu-sub-icon shell-nav-ico" aria-hidden>
                <IconChevron open={addToProjectChatId === chat.id} />
              </span>
            </button>
            {addToProjectChatId === chat.id && projects.length > 0 && (
              <div className="layout-sidebar-chat-item-submenu">
                {projects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    className="layout-sidebar-chat-item-menu-btn"
                    onClick={() => {
                      onChatProjectChange?.(chat.id, project.id);
                      closeMenu();
                    }}
                  >
                    {project.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          className="layout-sidebar-chat-item-menu-btn"
          role="menuitem"
          onClick={() => {
            closeMenu();
            const ok = window.confirm(t("sidebar.deleteChatConfirm"));
            if (ok) onDeleteChat?.(chat.id);
            // Native confirm steals keyboard focus on Windows Electron even on Cancel.
            else void restoreShellFocus();
          }}
        >
          <span className="layout-sidebar-chat-item-menu-icon shell-nav-ico" aria-hidden><IconTrash /></span>
          {t("sidebar.deleteChat")}
        </button>
      </div>,
      document.body
    );
  };

  const renderChatRow = (chat: ChatItem, nested = false) => {
    const streaming = streamingChatIds.includes(chat.id);
    const attention = !streaming && attentionChatIds.includes(chat.id);
    const statusTitle = streaming
      ? t("sidebar.chatStreaming")
      : attention
        ? t("sidebar.chatReady")
        : undefined;
    return (
    <div
      key={chat.id}
      className={`layout-sidebar-chat-item-row${nested ? " layout-sidebar-chat-item-row-nested" : ""}${currentChatId === chat.id ? " layout-sidebar-chat-item-active" : ""}${openMenuId === chat.id ? " layout-sidebar-chat-item-row--menu-open" : ""}${streaming ? " layout-sidebar-chat-item-row--streaming" : ""}${attention ? " layout-sidebar-chat-item-row--attention" : ""}`}
      ref={openMenuId === chat.id ? menuRef : undefined}
    >
      <button type="button" className={`layout-sidebar-chat-item${nested ? " layout-sidebar-chat-item-nested" : ""}`} onClick={() => handleSelectChat(chat.id)} title={chat.title}>
        <span className="layout-sidebar-chat-item-title">{chat.title}</span>
        {chat.favorited ? (
          <span className="layout-sidebar-chat-item-badge layout-sidebar-chat-item-badge--star" title={t("sidebar.unfavorite")} aria-hidden>
            <IconStar size={11} filled />
          </span>
        ) : null}
        {chat.pinned ? (
          <span className="layout-sidebar-chat-item-badge layout-sidebar-chat-item-badge--pin" title={t("sidebar.unpin")} aria-hidden>
            <IconPin size={11} filled />
          </span>
        ) : null}
        {streaming ? (
          <span className="layout-sidebar-chat-item-status" title={statusTitle} aria-label={statusTitle}>
            <IconSpinner size={12} className="layout-sidebar-chat-spinner" />
          </span>
        ) : attention ? (
          <span className="layout-sidebar-chat-item-status layout-sidebar-chat-item-status--alert" title={statusTitle} aria-label={statusTitle}>
            <IconAlertDot size={10} />
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className="layout-sidebar-chat-item-actions"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          toggleChatMenu(chat.id, event.currentTarget);
        }}
        aria-label={t("sidebar.actions")}
        aria-expanded={openMenuId === chat.id}
      >
        <span className="shell-nav-ico" aria-hidden><IconMore /></span>
      </button>
      {openMenuId === chat.id && renderChatMenu(chat)}
    </div>
    );
  };

  const allChats = searchQuery.trim() ? chats : chats.filter((chat) => !chat.projectId);
  const allChatGroups = groupChatsByDate(allChats, t);

  return (
    <aside className={`layout-sidebar ${open ? "" : "layout-sidebar-closed"}`} aria-label={t("sidebar.aria")}>
      <div className="layout-sidebar-inner">
        {onToggle ? (
          <div className="shell-sidebar-toolbar">
            <button
              type="button"
              className="layout-sidebar-toggle"
              onClick={onToggle}
              aria-label={t("common.closeMenu")}
              aria-expanded={open}
              title={t("common.closeMenu")}
            >
              <IconMenu size={18} />
            </button>
          </div>
        ) : null}
        <div className="shell-nav" ref={newChatMenuRef}>
          <div className="shell-nav-row">
            <button
              type="button"
              className="shell-nav-btn shell-nav-btn-main"
              onClick={() => handleNewChat(null)}
            >
              <span className="shell-nav-ico" aria-hidden>
                <IconPlus />
              </span>
              <span>{t("sidebar.newTask")}</span>
            </button>
            {projects.length > 0 && (
              <button
                type="button"
                className="shell-nav-chevron"
                onClick={() => setNewChatMenuOpen((v) => !v)}
                aria-expanded={newChatMenuOpen}
                aria-label={t("sidebar.inProject", { name: "…" })}
                title={t("sidebar.plainChat")}
              >
                <IconChevron open={newChatMenuOpen} size={16} />
              </button>
            )}
          </div>
          {newChatMenuOpen && projects.length > 0 && (
            <div className="layout-sidebar-chat-item-menu layout-sidebar-new-chat-menu">
              <button type="button" className="layout-sidebar-chat-item-menu-btn" onClick={() => handleNewChat(null)}>
                {t("sidebar.plainChat")}
              </button>
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className="layout-sidebar-chat-item-menu-btn"
                  onClick={() => handleNewChat(project.id)}
                >
                  {t("sidebar.inProject", { name: project.name })}
                </button>
              ))}
            </div>
          )}
          <button type="button" className="shell-nav-btn" onClick={() => navigate("/cabinet/skills")}>
            <span className="shell-nav-ico" aria-hidden>
              <IconSpark />
            </span>
            <span>{t("sidebar.skills")}</span>
          </button>
          {hasGalleryImages ? (
            <button
              type="button"
              className={`shell-nav-btn${pulseGallery ? " shell-nav-btn-appear" : ""}`}
              onClick={() => navigate("/gallery")}
            >
              <span className="shell-nav-ico" aria-hidden>
                <IconImage />
              </span>
              <span>{t("sidebar.gallery")}</span>
            </button>
          ) : null}
          {hasDocuments ? (
            <button
              type="button"
              className={`shell-nav-btn${pulseDocuments ? " shell-nav-btn-appear" : ""}`}
              onClick={() => navigate("/documents")}
            >
              <span className="shell-nav-ico" aria-hidden>
                <IconFile />
              </span>
              <span>{t("sidebar.documents")}</span>
            </button>
          ) : null}
          {sipEnabled ? (
            <button type="button" className="shell-nav-btn" onClick={() => navigate("/calls")}>
              <span className="shell-nav-ico" aria-hidden>
                <IconPhone />
              </span>
              <span>{t("sidebar.calls")}</span>
            </button>
          ) : null}
        </div>

        <div className="shell-search shell-search-always">
          <span className="shell-search-ico" aria-hidden>
            <IconSearch size={16} />
          </span>
          <input
            type="search"
            placeholder={t("sidebar.searchPlaceholder")}
            aria-label={t("sidebar.searchAria")}
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </div>

        {dynamic.items.length > 0 && (
          <div className="layout-sidebar-section layout-sidebar-dynamic">
            <div className="layout-sidebar-section-title">{dynamic.title || t("sidebar.context")}</div>
            <div className="shell-dynamic-list">
              {dynamic.items.map((item) => {
                const status = item.status ?? "open";
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`shell-dynamic-item shell-dynamic-item--${status}`}
                    title={item.note || undefined}
                    onClick={() => void handleDynamicItem(item)}
                  >
                    <span className="shell-nav-ico" aria-hidden>
                      <SidebarGlyphIcon name={item.icon} />
                    </span>
                    <span className="shell-dynamic-label">{item.label}</span>
                    {status !== "open" && (
                      <span className="shell-dynamic-status" aria-hidden>
                        {status === "active" ? <IconSpinner size={12} /> : <IconCheck size={12} />}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="layout-sidebar-section layout-sidebar-section-projects">
          <div className="layout-sidebar-section-title">{t("sidebar.projects")}</div>
          {projects.length === 0 ? (
            <div className="layout-sidebar-placeholder">{t("sidebar.noProjects")}</div>
          ) : (
            <div className="layout-sidebar-projects-tree">
              {projects.map((project) => {
                const expanded = expandedProjectIds.has(project.id);
                const projectChats = chatsInProject(chats, project.id);
                return (
                  <div key={project.id} className="layout-sidebar-project-node">
                    <div className="layout-sidebar-project-head">
                      <button type="button" className="layout-sidebar-project-toggle" onClick={() => toggleProject(project.id)} aria-expanded={expanded} aria-label={expanded ? t("sidebar.collapse") : t("sidebar.expand")}>
                        <span className="layout-sidebar-project-toggle-icon shell-nav-ico" aria-hidden><IconChevron open={expanded} /></span>
                      </button>
                      <span
                        className="layout-sidebar-project-name"
                        title={
                          project.description?.trim()
                            ? `${project.name}\n${project.description.trim()}`
                            : project.name
                        }
                      >
                        {project.name}
                      </span>
                      <button
                        type="button"
                        className="layout-sidebar-project-edit"
                        onClick={() => openProjectGoalEditor(project)}
                        aria-label={t("sidebar.editProjectGoalAria", { name: project.name })}
                        title={t("sidebar.editProjectGoalTitle")}
                      >
                        <span className="shell-nav-ico" aria-hidden><IconEdit /></span>
                      </button>
                      {projectChats.length === 0 && onDeleteProject && (
                        <button
                          type="button"
                          className="layout-sidebar-project-delete layout-sidebar-project-delete--always"
                          onClick={() => window.confirm(t("sidebar.deleteProjectConfirm", { name: project.name })) && onDeleteProject(project.id)}
                          aria-label={t("sidebar.deleteProjectAria", { name: project.name })}
                          title={t("sidebar.deleteProjectTitle")}
                        >
                          <span className="shell-nav-ico" aria-hidden><IconTrash /></span>
                        </button>
                      )}
                      <button type="button" className="layout-sidebar-project-add" onClick={() => handleNewChat(project.id)} aria-label={t("sidebar.newChatInProjectAria", { name: project.name })} title={t("sidebar.newChatInProjectTitle", { name: project.name })}>
                        <span className="shell-nav-ico" aria-hidden><IconPlus /></span>
                      </button>
                    </div>
                    {editingProjectId === project.id && (
                      <form
                        className="shell-project-goal-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void handleSaveProjectGoal();
                        }}
                      >
                        <textarea
                          value={projectDescDraft}
                          onChange={(e) => setProjectDescDraft(e.target.value)}
                          placeholder={t("sidebar.projectGoalPlaceholder")}
                          aria-label={t("sidebar.projectGoalLabel")}
                          rows={3}
                          disabled={savingProjectDesc}
                          maxLength={4000}
                        />
                        {projectDescError && <p className="layout-sidebar-error">{projectDescError}</p>}
                        <div className="shell-project-form-actions">
                          <button type="submit" disabled={savingProjectDesc}>
                            {savingProjectDesc ? t("common.saving") : t("common.save")}
                          </button>
                          <button
                            type="button"
                            disabled={savingProjectDesc}
                            onClick={() => {
                              setEditingProjectId(null);
                              setProjectDescDraft("");
                              setProjectDescError(null);
                            }}
                          >
                            {t("sidebar.cancel")}
                          </button>
                        </div>
                      </form>
                    )}
                    {expanded && project.description?.trim() && editingProjectId !== project.id && (
                      <p className="layout-sidebar-project-goal" title={project.description}>
                        {project.description.trim()}
                      </p>
                    )}
                    {expanded && (
                      <div className="layout-sidebar-project-chats">
                        {projectChats.length === 0 ? <div className="layout-sidebar-placeholder layout-sidebar-project-placeholder">{t("sidebar.noChats")}</div> : projectChats.map((chat) => renderChatRow(chat, true))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {projectFormOpen ? (
            <form
              className="shell-project-form"
              onSubmit={(e) => {
                e.preventDefault();
                void handleCreateProject();
              }}
            >
              <input
                ref={projectInputRef}
                type="text"
                value={projectNameDraft}
                onChange={(e) => setProjectNameDraft(e.target.value)}
                placeholder={t("sidebar.projectNamePlaceholder")}
                aria-label={t("sidebar.projectNamePrompt")}
                disabled={creatingProject}
              />
              {projectError && <p className="layout-sidebar-error">{projectError}</p>}
              <div className="shell-project-form-actions">
                <button type="submit" disabled={creatingProject || !projectNameDraft.trim()}>
                  {creatingProject ? t("common.saving") : t("sidebar.createProject")}
                </button>
                <button
                  type="button"
                  disabled={creatingProject}
                  onClick={() => {
                    setProjectFormOpen(false);
                    setProjectNameDraft("");
                    setProjectError(null);
                  }}
                >
                  {t("sidebar.cancel")}
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              className="layout-sidebar-link"
              onClick={() => {
                setProjectFormOpen(true);
                setProjectError(null);
              }}
              disabled={creatingProject}
            >
              {t("sidebar.newProject")}
            </button>
          )}
        </div>

        <div className="layout-sidebar-section layout-sidebar-section-chats">
          <div className="layout-sidebar-section-title">{t("sidebar.allChats")}</div>
          <div className="layout-sidebar-chat-list">
            {listError ? <div className="layout-sidebar-error">{listError}</div>
              : listLoading ? <div className="layout-sidebar-placeholder">{t("common.loading")}</div>
                : allChatGroups.length === 0 ? <div className="layout-sidebar-placeholder">{searchQuery.trim() ? t("sidebar.nothingFound") : t("sidebar.noChats")}</div>
                  : allChatGroups.map((group) => (
                    <div key={group.label} className="layout-sidebar-chat-group">
                      <div className="layout-sidebar-chat-group-label">{group.label}</div>
                      {group.items.map((chat) => renderChatRow(chat))}
                    </div>
                  ))}
          </div>
        </div>

        <div className="layout-sidebar-footer">
          <span
            className={`shell-avatar${webMode ? " shell-avatar--web" : ""}`}
            aria-hidden
            title={webMode ? t("sidebar.webModeActive") : displayName}
          >
            {avatarLetter}
          </span>
          <button
            type="button"
            className={`shell-icon-btn shell-icon-btn--globe${webMode ? " shell-icon-btn--active" : ""}`}
            onClick={() => {
              if (isCabinet || location.pathname.startsWith("/gallery") || location.pathname.startsWith("/documents") || location.pathname.startsWith("/calls")) {
                navigate("/chat");
              }
              onToggleMainSurface?.();
            }}
            aria-label={globeTitle}
            title={globeTitle}
            aria-pressed={webMode}
          >
            <span className="shell-nav-ico" aria-hidden>
              <IconGlobe size={18} />
            </span>
          </button>
          <button
            type="button"
            className="shell-icon-btn"
            onClick={() => navigate(isCabinet ? "/chat" : "/cabinet/settings")}
            aria-label={isCabinet ? t("sidebar.toChat") : t("sidebar.settings")}
            title={isCabinet ? t("sidebar.toChat") : t("sidebar.settings")}
          >
            <span className="shell-nav-ico" aria-hidden>{isCabinet ? <IconChat /> : <IconSettings />}</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
