// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { useCallback, useEffect, useState } from "react";
import {
  deleteChatDocument,
  downloadChatFile,
  fetchChatDocuments,
  fileDownloadUrl,
  type ChatDocumentItem,
} from "../api/chat";
import { useChatPageContext } from "../context/ChatPageContext";
import { useT } from "../i18n";
import { FileIcon, getFileTypeLabel } from "./FileIcon";
import { IconDownload, IconTrash } from "./icons";

export function DocumentsTab() {
  const t = useT();
  const { currentChatId } = useChatPageContext();
  const [documents, setDocuments] = useState<ChatDocumentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!currentChatId) {
      setDocuments([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    fetchChatDocuments(currentChatId)
      .then(setDocuments)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [currentChatId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async (doc: ChatDocumentItem) => {
    setBusyPath(doc.path);
    try {
      await downloadChatFile(doc.path, doc.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyPath(null);
    }
  };

  const handleOpen = (doc: ChatDocumentItem) => {
    window.open(fileDownloadUrl(doc.path).replace(/\?download=1$/, ""), "_blank", "noopener,noreferrer");
  };

  const handleDelete = async (doc: ChatDocumentItem) => {
    if (!window.confirm(t("documents.deleteConfirm", { name: doc.name }))) return;
    setBusyPath(doc.path);
    try {
      await deleteChatDocument(doc.path, currentChatId ?? undefined);
      setDocuments((prev) => prev.filter((x) => x.path !== doc.path));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyPath(null);
    }
  };

  if (!currentChatId) {
    return <p className="gallery-empty">{t("documents.noChat")}</p>;
  }

  return (
    <div className="gallery-panel documents-panel">
      <p className="gallery-desc">{t("documents.desc")}</p>
      {error && (
        <p className="gallery-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p className="gallery-empty">{t("documents.loading")}</p>
      ) : documents.length === 0 ? (
        <p className="gallery-empty">{t("documents.empty")}</p>
      ) : (
        <ul className="documents-list" aria-label={t("documents.listAria")}>
          {documents.map((doc) => {
            const busy = busyPath === doc.path;
            return (
              <li key={doc.path} className="documents-card">
                <button
                  type="button"
                  className="documents-card-preview"
                  onClick={() => handleOpen(doc)}
                  title={t("documents.open")}
                  aria-label={t("documents.open")}
                >
                  <FileIcon filename={doc.name} size={40} />
                </button>
                <div className="documents-card-body">
                  <div className="documents-card-meta" title={doc.name}>
                    <span className="documents-card-name">{doc.name}</span>
                    <span className="documents-card-type">{getFileTypeLabel(doc.name)}</span>
                  </div>
                  <div className="documents-card-link" title={doc.url}>
                    {doc.url}
                  </div>
                  <div className="gallery-card-actions">
                    <button
                      type="button"
                      className="gallery-btn"
                      disabled={busy}
                      onClick={() => handleOpen(doc)}
                      title={t("documents.open")}
                      aria-label={t("documents.open")}
                    >
                      <span>{t("documents.open")}</span>
                    </button>
                    <button
                      type="button"
                      className="gallery-btn"
                      disabled={busy}
                      onClick={() => void handleSave(doc)}
                      title={t("documents.save")}
                      aria-label={t("documents.save")}
                    >
                      <IconDownload size={16} />
                      <span>{t("documents.save")}</span>
                    </button>
                    <button
                      type="button"
                      className="gallery-btn gallery-btn-danger"
                      disabled={busy}
                      onClick={() => void handleDelete(doc)}
                      title={t("documents.delete")}
                      aria-label={t("documents.delete")}
                    >
                      <IconTrash size={16} />
                      <span>{t("documents.delete")}</span>
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
