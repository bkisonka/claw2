// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Composer queue panel: numbered messages the user submitted while a reply
 * was streaming. Drag to reorder, edit (back into the composer), delete, and
 * "send now" — interrupt the running generation and send this message.
 */
import { useRef, useState } from "react";
import type { QueuedMessage } from "../store/composerQueue";
import { useT } from "../i18n";
import { IconBolt, IconEdit, IconTrash } from "./icons";

type Props = {
  queue: QueuedMessage[];
  onSendNow: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onMove: (from: number, to: number) => void;
};

export function ChatQueuePanel({ queue, onSendNow, onEdit, onRemove, onMove }: Props) {
  const t = useT();
  const dragFromRef = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  if (queue.length === 0) return null;

  return (
    <div className="chat-queue" role="list" aria-label={t("chat.queuePanelAria")}>
      {queue.map((m, i) => (
        <div
          key={m.id}
          className={`chat-queue-item${dragOver === i ? " chat-queue-item--drop" : ""}`}
          role="listitem"
          aria-label={t("chat.queueItemAria", { n: i + 1 })}
          draggable
          onDragStart={(e) => {
            dragFromRef.current = i;
            e.dataTransfer.effectAllowed = "move";
            try {
              e.dataTransfer.setData("text/plain", m.id);
            } catch {
              /* IE-style guards — dragging still works via the index */
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDragOver(i);
          }}
          onDragLeave={() => setDragOver((cur) => (cur === i ? null : cur))}
          onDrop={(e) => {
            e.preventDefault();
            const from = dragFromRef.current;
            dragFromRef.current = null;
            setDragOver(null);
            if (from != null) onMove(from, i);
          }}
          onDragEnd={() => {
            dragFromRef.current = null;
            setDragOver(null);
          }}
        >
          <span className="chat-queue-item-handle" title={t("chat.queueDragTitle")} aria-hidden>
            ⠿
          </span>
          <span className="chat-queue-item-n">{i + 1}</span>
          <span className="chat-queue-item-text" title={m.text}>{m.text}</span>
          <button
            type="button"
            className="chat-queue-item-btn chat-queue-item-btn--force"
            onClick={() => onSendNow(m.id)}
            title={t("chat.queueSendNowTitle")}
            aria-label={t("chat.queueSendNowAria")}
          >
            <IconBolt size={13} />
          </button>
          <button
            type="button"
            className="chat-queue-item-btn"
            onClick={() => onEdit(m.id)}
            title={t("chat.queueEditTitle")}
            aria-label={t("chat.queueEditTitle")}
          >
            <IconEdit size={13} />
          </button>
          <button
            type="button"
            className="chat-queue-item-btn"
            onClick={() => onRemove(m.id)}
            title={t("chat.queueDeleteTitle")}
            aria-label={t("chat.queueDeleteTitle")}
          >
            <IconTrash size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
