// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useEffect, useState } from "react";
import type { ChatListItemApi } from "../api/chat";
import { IconDownload, IconTrash } from "./icons";

interface ChatListProps {
  chats: ChatListItemApi[];
  currentId: string;
  loading?: boolean;
  error?: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string, title: string) => void;
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

export function ChatList({ chats, currentId, loading, error, onSelect, onDelete, onExport }: ChatListProps) {
  /** Two-step inline delete confirmation (window.confirm is out of place on a wide pane). */
  const [confirmId, setConfirmId] = useState<string | null>(null);
  useEffect(() => {
    if (!confirmId) return;
    const t = window.setTimeout(() => setConfirmId(null), 4000);
    return () => window.clearTimeout(t);
  }, [confirmId]);

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
      <ul className="chats-view-list">
        {chats.map((c) => {
          const title = c.title || "Без названия";
          return (
            <li key={c.id} className={c.id === currentId ? "tg-chat-row active" : "tg-chat-row"}>
              <button type="button" className="tg-chat-row-main" onClick={() => onSelect(c.id)}>
                <span
                  className="tg-avatar"
                  style={{ background: avatarGray(c.id) }}
                  aria-hidden
                >
                  {initials(title)}
                </span>
                <span className="tg-chat-row-text">
                  <span className="tg-chat-row-top">
                    <span className="tg-chat-row-title">{title}</span>
                    <span className="tg-chat-row-time">{formatUpdated(c.updated_at)}</span>
                  </span>
                  <span className="tg-chat-row-preview">Чат claw2</span>
                </span>
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
            </li>
          );
        })}
      </ul>
    </div>
  );
}
