// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { ChatListItemApi } from "../api/chat";
import { IconDownload, IconEdit, IconFile, IconFork, IconImage, IconTrash } from "./icons";

interface ChatListProps {
  chats: ChatListItemApi[];
  currentId: string;
  loading?: boolean;
  error?: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string, title: string) => void;
  onDuplicate: (id: string, title: string) => void;
  onRename: (id: string, title: string) => void;
}

function formatUpdated(ts: number): string {
  if (!ts) return "";
  try {
    const d = new Date(ts < 1e12 ? ts * 1000 : ts);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) {
      return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  } catch {
    return "";
  }
}

function initials(title: string): string {
  const t = title.trim() || "?";
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return t.slice(0, 2).toUpperCase();
}

function hueFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Grayscale avatar: stable per-chat lightness band. */
function avatarGray(id: string): string {
  return `hsl(240 3% ${34 + (hueFromId(id) % 5) * 7}%)`;
}

/** Group forked chats under their parent (only parents visible in the same list). */
function buildForkChildren(chats: ChatListItemApi[]): Map<string, ChatListItemApi[]> {
  const ids = new Set(chats.map((c) => c.id));
  const map = new Map<string, ChatListItemApi[]>();
  for (const c of chats) {
    if (!c.forked_from_chat_id || !ids.has(c.forked_from_chat_id)) continue;
    const children = map.get(c.forked_from_chat_id);
    if (children) children.push(c);
    else map.set(c.forked_from_chat_id, [c]);
  }
  for (const children of map.values()) children.sort((a, b) => a.updated_at - b.updated_at);
  return map;
}

export function ChatList({ chats, currentId, loading, error, onSelect, onDelete, onExport, onDuplicate, onRename }: ChatListProps) {
  /** Two-step inline delete confirmation (window.confirm is out of place on a wide pane). */
  const [confirmId, setConfirmId] = useState<string | null>(null);
  /** Inline rename: id of the chat being renamed + draft text. */
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  useEffect(() => {
    if (!confirmId) return;
    const t = window.setTimeout(() => setConfirmId(null), 4000);
    return () => window.clearTimeout(t);
  }, [confirmId]);

  const commitRename = (id: string, previous: string) => {
    setRenameId(null);
    const next = renameDraft.trim().slice(0, 60);
    if (next && next !== previous) onRename(id, next);
  };

  const forkChildren = buildForkChildren(chats);
  const titles = new Map(chats.map((c) => [c.id, c.title] as const));

  const renderRow = (
    c: ChatListItemApi,
    depth: number,
    parentTitle?: string,
    seen: ReadonlySet<string> = new Set()
  ): ReactElement => {
    // Lineage is acyclic by construction; cap depth and re-visits anyway —
    // a corrupt store must not hang the list.
    if (depth > 10 || seen.has(c.id)) return <li key={`cycle-${c.id}`} hidden />;
    const title = c.title || "Без названия";
    const children = forkChildren.get(c.id) ?? [];
    const rowTitle = parentTitle ? `${title} (ответвлён от «${parentTitle}»)` : title;
    return (
      <li key={c.id} className={c.id === currentId ? "tg-chat-row active" : "tg-chat-row"}>
        <div className={depth > 0 ? "tg-chat-fork-node tg-chat-fork-node--nested" : "tg-chat-fork-node"}>
          <button
            type="button"
            className="tg-chat-row-main"
            onClick={() => onSelect(c.id)}
            title={rowTitle}
          >
            <span className="tg-avatar" style={{ background: avatarGray(c.id) }} aria-hidden>
              {initials(title)}
            </span>
            <span className="tg-chat-row-text">
              <span className="tg-chat-row-top">
                {renameId === c.id ? (
                <input
                  className="tg-chat-row-rename"
                  value={renameDraft}
                  maxLength={60}
                  autoFocus
                  aria-label="Новое название чата"
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); commitRename(c.id, title); }
                    else if (e.key === "Escape") { e.preventDefault(); setRenameId(null); }
                  }}
                  onBlur={() => commitRename(c.id, title)}
                />
              ) : (
                <>
                  <span className="tg-chat-row-title">{title}</span>
                  {c.hasImages ? <span className="tg-chat-attach-ico" title="В чате есть изображения"><IconImage size={13} /></span> : null}
                  {c.hasDocs ? <span className="tg-chat-attach-ico" title="В чате есть документы"><IconFile size={13} /></span> : null}
                </>
              )}
                <span className="tg-chat-row-time">{formatUpdated(c.updated_at)}</span>
              </span>
              <span className="tg-chat-row-preview">Чат claw2</span>
            </span>
          </button>
          <button
            type="button"
            className="tg-chat-row-action"
            title="Переименовать чат"
            aria-label={`Переименовать чат «${title}»`}
            onClick={(e) => {
              e.stopPropagation();
              if (renameId === c.id) setRenameId(null);
              else {
                setRenameDraft(title);
                setRenameId(c.id);
                setConfirmId(null);
              }
            }}
          >
            <IconEdit size={18} />
          </button>
          <button
            type="button"
            className="tg-chat-row-action"
            title="Ответвить (дублировать) чат"
            aria-label={`Создать копию чата «${title}»`}
            onClick={(e) => {
              e.stopPropagation();
              onDuplicate(c.id, title);
            }}
          >
            <IconFork size={18} />
          </button>
          <button
            type="button"
            className="tg-chat-row-action"
            title="Экспорт в MD"
            aria-label={`Экспортировать чат «${title}» в markdown`}
            onClick={(e) => {
              e.stopPropagation();
              onExport(c.id, title);
            }}
          >
            <IconDownload size={18} />
          </button>
          <button
            type="button"
            className={confirmId === c.id ? "tg-chat-row-delete tg-chat-row-delete--confirm" : "tg-chat-row-delete"}
            title={confirmId === c.id ? "Подтвердить удаление" : "Удалить"}
            aria-label={confirmId === c.id ? "Подтвердить удаление чата" : "Удалить чат"}
            onClick={(e) => {
              e.stopPropagation();
              if (confirmId === c.id) {
                setConfirmId(null);
                onDelete(c.id);
              } else {
                setConfirmId(c.id);
              }
            }}
          >
            {confirmId === c.id ? <span className="tg-chat-delete-check">✓</span> : <IconTrash size={18} />}
          </button>
        </div>
        {children.length > 0 && (
          <ul className="tg-chat-fork-children">
            {children.map((child) =>
              renderRow(child, depth + 1, titles.get(c.id) ?? title, new Set(seen).add(c.id))
            )}
          </ul>
        )}
      </li>
    );
  };

  const topLevel = chats.filter((c) => !(c.forked_from_chat_id && forkChildren.has(c.forked_from_chat_id)));

  return (
    <div className="chats-view" aria-label="Список чатов">
      {loading && chats.length === 0 && <p className="chats-view-status">Загрузка…</p>}
      {error && <p className="chats-view-status chats-view-status--error">{error}</p>}
      {!loading && !error && chats.length === 0 && (
        <div className="chats-empty">
          <p className="chats-empty-title">Нет чатов</p>
          <p className="chats-empty-sub">Нажмите + сверху, чтобы начать переписку</p>
        </div>
      )}
      <ul className="chats-view-list">{topLevel.map((c) => renderRow(c, 0))}</ul>
    </div>
  );
}
