// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { useCallback, useEffect, useState } from "react";
import {
  downloadAllCallLogsMd,
  downloadCallLogMd,
  fetchCallLog,
  fetchCallLogs,
  type CallLogRecord,
  type CallLogSummary,
} from "../api/calls";
import { useT } from "../i18n";
import { IconDownload } from "./icons";

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function CallsTab() {
  const t = useT();
  const [calls, setCalls] = useState<CallLogSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CallLogRecord | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchCallLogs()
      .then(setCalls)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    fetchCallLog(selectedId)
      .then(setDetail)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setDetailLoading(false));
  }, [selectedId]);

  const handleExportOne = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await downloadCallLogMd(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleExportAll = async () => {
    setBusy(true);
    setError(null);
    try {
      await downloadAllCallLogsMd();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="calls-panel gallery-panel">
      <div className="calls-toolbar">
        <p className="gallery-desc">{t("calls.desc")}</p>
        <button
          type="button"
          className="calls-export-btn"
          onClick={() => void handleExportAll()}
          disabled={busy || calls.length === 0}
        >
          <IconDownload size={16} />
          {t("calls.exportAll")}
        </button>
      </div>
      {error && (
        <p className="gallery-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p className="gallery-empty">{t("calls.loading")}</p>
      ) : calls.length === 0 ? (
        <p className="gallery-empty">{t("calls.empty")}</p>
      ) : (
        <div className="calls-layout">
          <ul className="calls-list" aria-label={t("calls.listAria")}>
            {calls.map((c) => {
              const active = selectedId === c.id;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    className={`calls-list-item${active ? " calls-list-item--active" : ""}`}
                    onClick={() => setSelectedId(c.id)}
                  >
                    <span className="calls-list-top">
                      <span className={`calls-dir calls-dir--${c.direction}`}>
                        {c.direction === "out" ? t("calls.outbound") : t("calls.inbound")}
                      </span>
                      <span className={`calls-state calls-state--${c.state}`}>{c.state}</span>
                    </span>
                    <span className="calls-remote" title={c.remote}>
                      {c.remote}
                    </span>
                    <span className="calls-when">{formatWhen(c.startedAt)}</span>
                    {c.preview ? <span className="calls-preview">{c.preview}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="calls-detail" aria-live="polite">
            {!selectedId ? (
              <p className="gallery-empty">{t("calls.selectHint")}</p>
            ) : detailLoading ? (
              <p className="gallery-empty">{t("calls.loading")}</p>
            ) : !detail ? (
              <p className="gallery-empty">{t("calls.notFound")}</p>
            ) : (
              <>
                <div className="calls-detail-head">
                  <div>
                    <h3 className="calls-detail-title">{detail.remote}</h3>
                    <p className="calls-detail-meta">
                      {detail.direction === "out" ? t("calls.outbound") : t("calls.inbound")}
                      {" · "}
                      {formatWhen(detail.startedAt)}
                      {detail.endedAt ? ` → ${formatWhen(detail.endedAt)}` : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="calls-export-btn"
                    onClick={() => void handleExportOne(detail.id)}
                    disabled={busy}
                  >
                    <IconDownload size={16} />
                    {t("calls.exportMd")}
                  </button>
                </div>
                <ol className="calls-timeline">
                  {detail.events.map((e, i) => (
                    <li key={`${e.at}-${e.type}-${i}`} className="calls-timeline-item">
                      <time dateTime={e.at}>{formatWhen(e.at)}</time>
                      <span className="calls-event-type">{e.type}</span>
                      {e.text ? <span className="calls-event-text">{e.text}</span> : null}
                      {e.detail && e.detail !== e.text ? (
                        <span className="calls-event-detail">{e.detail}</span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
