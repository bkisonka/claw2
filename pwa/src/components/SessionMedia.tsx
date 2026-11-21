// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useState, useEffect, useMemo, useRef } from "react";
import {
  deleteChatFile,
  fetchChatDocuments,
  downloadChatFile,
  fileDownloadUrl,
  resolveToDataUrl,
  type ChatDocumentItem,
} from "../api/chat";
import { base64ToBlob, getFileById, storedFileIdFromUrl } from "../engine/files";
import { IconTrash } from "./icons";
import { FileIcon } from "./FileIcon";

export type SessionFilesKind = "images" | "documents";

interface SessionMediaProps {
  sessionId: string;
  kind: SessionFilesKind;
  refreshTrigger?: number;
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic", "heif"]);

function isImageDoc(doc: ChatDocumentItem): boolean {
  const ext = (doc.ext || doc.name.split(".").pop() || "").toLowerCase().replace(/^\./, "");
  return IMAGE_EXT.has(ext);
}

function authImageUrl(pathOrUrl: string): string {
  const url = fileDownloadUrl(pathOrUrl).replace(/\?download=1/, "");
  // Prefer inline display; gateway /files/ serves with auth headers via fetch blob below
  return url;
}

export function SessionMedia({ sessionId, kind, refreshTrigger }: SessionMediaProps) {
  const [docs, setDocs] = useState<ChatDocumentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  /** Two-step delete confirmation (same pattern as the chat list). */
  const [confirmId, setConfirmId] = useState<string | null>(null);
  /** Mirror of `previews` for the unmount cleanup (the effect closure is stale). */
  const previewsRef = useRef<Record<string, string>>({});

  useEffect(() => {
    if (!sessionId.trim()) {
      setDocs([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    fetchChatDocuments(sessionId)
      .then(setDocs)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [sessionId, refreshTrigger]);

  const filtered = useMemo(() => {
    if (kind === "images") return docs.filter(isImageDoc);
    return docs.filter((d) => !isImageDoc(d));
  }, [docs, kind]);

  const filteredKey = filtered.map((d) => d.path || d.url).join("|");

  useEffect(() => {
    if (kind !== "images" || !filtered.length) return;
    let cancelled = false;
    const items = filtered;
    (async () => {
      const next: Record<string, string> = {};
      for (const doc of items) {
        const key = doc.path || doc.url;
        try {
          // Stored refs decode straight to a Blob — the fetch(dataUrl) path
          // copied every byte twice more (string → Response → Blob).
          const id = storedFileIdFromUrl(key);
          if (id) {
            const f = await getFileById(id);
            if (!f) continue;
            if (cancelled) return;
            next[key] = URL.createObjectURL(base64ToBlob(f.mimeType, f.base64));
          } else {
            const res = await fetch(await resolveToDataUrl(authImageUrl(key)));
            if (!res.ok) continue;
            const blob = await res.blob();
            if (cancelled) return;
            next[key] = URL.createObjectURL(blob);
          }
        } catch {
          /* skip */
        }
      }
      if (!cancelled) {
        setPreviews((prev) => {
          for (const u of Object.values(prev)) URL.revokeObjectURL(u);
          return next;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filteredKey tracks list identity
  }, [kind, filteredKey]);

  useEffect(() => {
    previewsRef.current = previews;
  }, [previews]);

  useEffect(() => {
    return () => {
      for (const u of Object.values(previewsRef.current)) URL.revokeObjectURL(u);
    };
  }, []);

  // Auto-dismiss the delete confirmation after a pause, like the chat list.
  useEffect(() => {
    if (!confirmId) return;
    const t = window.setTimeout(() => setConfirmId(null), 4000);
    return () => window.clearTimeout(t);
  }, [confirmId]);

  /** Agent-saved files only (the API flags them); message attachments are
   *  part of the tape and have no delete button. */
  const canDelete = (doc: ChatDocumentItem): boolean => doc.deletable === true;

  const remove = async (doc: ChatDocumentItem) => {
    const key = doc.path || doc.url;
    setBusyPath(key);
    setError(null);
    try {
      const ok = await deleteChatFile(key);
      if (!ok) {
        setError("Этот файл нельзя удалить отдельно — он вложен в сообщение.");
        return;
      }
      setPreviews((prev) => {
        const u = prev[key];
        if (u) URL.revokeObjectURL(u);
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setDocs((prev) => prev.filter((d) => (d.path || d.url) !== key));
      setConfirmId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyPath(null);
    }
  };

  const save = async (doc: ChatDocumentItem) => {
    setBusyPath(doc.path);
    setError(null);
    try {
      await downloadChatFile(doc.path || doc.url, doc.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyPath(null);
    }
  };

  const emptyLabel =
    kind === "images"
      ? "Пока нет изображений в этом чате. Файлы привязаны к чату, в котором созданы."
      : "Пока нет документов в этом чате. Файлы привязаны к чату, в котором созданы, — проверь тот чат, где просил сохранить.";

  if (!sessionId.trim()) {
    return (
      <div className="session-files session-files--empty">
        <p>Откройте чат — здесь появятся {kind === "images" ? "изображения" : "документы"} сессии.</p>
      </div>
    );
  }

  if (loading) return <div className="session-files session-files--loading">Загрузка…</div>;
  if (error && filtered.length === 0) {
    return <div className="session-files session-files--error">Ошибка: {error}</div>;
  }

  if (filtered.length === 0) {
    return (
      <div className="session-files session-files--empty">
        <p>{emptyLabel}</p>
      </div>
    );
  }

  if (kind === "images") {
    return (
      <div className="session-files session-images">
        {error && <p className="session-files--error">{error}</p>}
        <div className="session-images-grid">
          {filtered.map((f) => {
            const key = f.path || f.url;
            const src = previews[key];
            const confirming = confirmId === key;
            const deletable = canDelete(f);
            return (
              <div key={key} className="session-images-tile-wrap">
                <button
                  type="button"
                  className="session-images-tile"
                  disabled={busyPath === key}
                  onClick={() => void save(f)}
                  title={f.name}
                >
                  {src ? (
                    <img src={src} alt={f.name} className="session-images-img" />
                  ) : (
                    <span className="session-images-placeholder">{f.name}</span>
                  )}
                </button>
                {deletable && (
                  <button
                    type="button"
                    className={`session-file-delete${confirming ? " session-file-delete--confirm" : ""}`}
                    disabled={busyPath === key}
                    title={confirming ? "Подтвердить удаление" : "Удалить файл"}
                    aria-label={confirming ? `Подтвердить удаление файла «${f.name}»` : `Удалить файл «${f.name}»`}
                    onClick={() => {
                      if (confirming) void remove(f);
                      else setConfirmId(key);
                    }}
                  >
                    {confirming ? "✓" : <IconTrash size={16} />}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      <p className="session-files-hint">Нажмите на картинку, чтобы сохранить или поделиться, ✓ в углу — удалить.</p>
      </div>
    );
  }

  return (
    <div className="session-files">
      {error && <p className="session-files--error">{error}</p>}
      <ul className="session-files-list">
        {filtered.map((f) => {
          const key = f.path || f.url;
          const confirming = confirmId === key;
          const deletable = canDelete(f);
          return (
            <li key={key} className="session-files-item">
              <FileIcon filename={f.name} size={20} />
              <button
                type="button"
                className="session-files-link"
                disabled={busyPath === key}
                onClick={() => void save(f)}
              >
                {busyPath === key ? "Сохранение…" : f.name}
              </button>
              {deletable && (
                <button
                  type="button"
                  className={`session-file-delete session-file-delete--row${confirming ? " session-file-delete--confirm" : ""}`}
                  disabled={busyPath === key}
                  title={confirming ? "Подтвердить удаление" : "Удалить файл"}
                  aria-label={confirming ? `Подтвердить удаление файла «${f.name}»` : `Удалить файл «${f.name}»`}
                  onClick={() => {
                    if (confirming) void remove(f);
                    else setConfirmId(key);
                  }}
                >
                  {confirming ? "✓" : <IconTrash size={16} />}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="session-files-hint">
        Файл откроется в системном меню «Поделиться» — сохраните в файлы устройства или отправьте в приложение.
        Корзина удаляет файл из сессии безвозвратно.
      </p>
    </div>
  );
}
