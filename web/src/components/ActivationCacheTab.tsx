// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useCallback, useEffect, useState } from "react";
import {
  acceptCatalogCache,
  deleteCatalogCache,
  getCatalogCaches,
  importCatalogCache,
  renameCatalogCache,
  type CatalogCache,
  type CatalogCacheScan,
} from "../api/catalog";
import { getConfig, putConfig, type Config } from "../api/config";
import { useT } from "../i18n";
import { isSingleUserClient } from "../lib/singleUser";

export function ActivationCacheTab() {
  const t = useT();
  const isDesktop = isSingleUserClient();
  const [caches, setCaches] = useState<CatalogCache[]>([]);
  const [quarantined, setQuarantined] = useState<CatalogCache[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [cacheStorePath, setCacheStorePath] = useState("");
  const [pendingFile, setPendingFile] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const refreshList = useCallback(async () => {
    const list = await getCatalogCaches().catch(() => ({ caches: [], quarantined: [] }));
    setCaches(Array.isArray(list.caches) ? list.caches : []);
    setQuarantined(Array.isArray(list.quarantined) ? list.quarantined : []);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const [list, cfg] = await Promise.all([
        getCatalogCaches().catch(() => ({ caches: [], quarantined: [] })),
        getConfig(),
      ]);
      setCaches(Array.isArray(list.caches) ? list.caches : []);
      setQuarantined(Array.isArray(list.quarantined) ? list.quarantined : []);
      setConfig(cfg);
      const orch = cfg?.orchestrator as
        | { activationCache?: string | null; cacheStorePath?: string | null }
        | undefined;
      setSelectedId(orch?.activationCache ?? null);
      setCacheStorePath(typeof orch?.cacheStorePath === "string" ? orch.cacheStorePath : "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const persistOrchestrator = useCallback(
    async (patch: Record<string, unknown>) => {
      if (!config) return;
      setSaving(true);
      setError(null);
      try {
        const orch =
          typeof config.orchestrator === "object" && config.orchestrator !== null
            ? (config.orchestrator as Record<string, unknown>)
            : {};
        const updated: Config = {
          ...config,
          orchestrator: { ...orch, ...patch },
        };
        await putConfig(updated);
        setConfig(updated);
        if ("activationCache" in patch) {
          setSelectedId((patch.activationCache as string | null) ?? null);
        }
        if ("cacheStorePath" in patch && typeof patch.cacheStorePath === "string") {
          setCacheStorePath(patch.cacheStorePath);
        } else if ("cacheStorePath" in patch && patch.cacheStorePath == null) {
          setCacheStorePath("");
        }
        return updated;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        setSaving(false);
      }
    },
    [config]
  );

  const handleSelect = useCallback(
    async (cacheId: string | null) => {
      try {
        await persistOrchestrator({ activationCache: cacheId || null });
      } catch {
        /* error already set */
      }
    },
    [persistOrchestrator]
  );

  const handleSavePath = useCallback(async () => {
    try {
      await persistOrchestrator({ cacheStorePath: cacheStorePath.trim() || null });
      await refreshList();
    } catch {
      /* error already set */
    }
  }, [persistOrchestrator, cacheStorePath, refreshList]);

  const handleBrowseDirectory = useCallback(async () => {
    if (!window.claw2Desktop?.pickDirectory) return;
    const res = await window.claw2Desktop.pickDirectory({
      title: t("cache.browseDirTitle"),
      defaultPath: cacheStorePath.trim() || undefined,
    });
    if (!res.ok || !res.path) return;
    setCacheStorePath(res.path);
    try {
      await persistOrchestrator({ cacheStorePath: res.path });
      await refreshList();
    } catch {
      /* error already set */
    }
  }, [cacheStorePath, persistOrchestrator, refreshList, t]);

  const scanNotice = useCallback(
    (scan: CatalogCacheScan) => {
      if (!scan.passedInjectionScan) {
        return t("cache.importFlagged", { count: scan.injectionIssues });
      }
      return scan.signed ? t("cache.importOkSigned") : t("cache.importOk");
    },
    [t]
  );

  const handlePickCacheFile = useCallback(async () => {
    if (!window.claw2Desktop?.pickFile) return;
    if (!cacheStorePath.trim()) {
      setError(t("cache.needDirFirst"));
      return;
    }
    const res = await window.claw2Desktop.pickFile({
      title: t("cache.browseFileTitle"),
      defaultPath: cacheStorePath.trim() || undefined,
      filters: [
        { name: "Claw cache", extensions: ["claw-cache"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (!res.ok || !res.path) return;
    setPendingFile(res.path);
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      // Imported caches land in quarantine and never auto-activate: a shared
      // cache is a third-party prompt. Explicit acceptance is a separate step.
      const { cache, scan } = await importCatalogCache(res.path);
      setNotice(`${t("cache.importQuarantined", { name: cache.name })} ${scanNotice(scan)}`);
      await refreshList();
      setPendingFile("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPendingFile("");
    } finally {
      setSaving(false);
    }
  }, [cacheStorePath, persistOrchestrator, refreshList, scanNotice, t]);

  const handleAccept = useCallback(
    async (c: CatalogCache) => {
      if (!window.confirm(t("cache.acceptConfirm", { name: c.name }))) return;
      setSaving(true);
      setError(null);
      try {
        const accepted = await acceptCatalogCache(c.file_name);
        setNotice(t("cache.accepted", { name: accepted.name }));
        await refreshList();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [refreshList, t]
  );

  const handleRename = useCallback(
    async (c: CatalogCache) => {
      const name = renameValue.trim();
      if (!name || renamingFile !== c.file_name) return;
      setSaving(true);
      setError(null);
      try {
        await renameCatalogCache(c.file_name, name);
        setRenamingFile(null);
        setRenameValue("");
        await refreshList();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [renameValue, renamingFile, refreshList]
  );

  const handleDelete = useCallback(
    async (c: CatalogCache, isQuarantined: boolean) => {
      if (!window.confirm(t("cache.deleteConfirm", { name: c.name }))) return;
      setSaving(true);
      setError(null);
      try {
        await deleteCatalogCache(c.file_name);
        if (!isQuarantined && selectedId === c.cache_id) {
          await persistOrchestrator({ activationCache: null });
        }
        await refreshList();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [selectedId, persistOrchestrator, refreshList, t]
  );

  if (loading) {
    return (
      <div className="cabinet-section">
        <p>{t("cache.loading")}</p>
      </div>
    );
  }

  const metaLine = (c: CatalogCache) => {
    const parts = [c.domain, c.language].filter(Boolean).join(" · ");
    const author = c.author ? `${t("cache.author")}: ${c.author}` : "";
    const badge = c.signed ? ` · ${t("cache.signed")}` : "";
    return [parts, author].filter(Boolean).join(" · ") + badge + (c.description ? ` — ${c.description}` : "");
  };

  const cacheRow = (c: CatalogCache, isQuarantined: boolean) => (
    <div key={`${isQuarantined ? "q" : "a"}-${c.file_name}`} className="activation-cache-row">
      {!isQuarantined ? (
        <label className="activation-cache-item">
          <input
            type="radio"
            name="activationCache"
            checked={selectedId === c.cache_id}
            onChange={() => void handleSelect(c.cache_id)}
            disabled={saving}
          />
          {renamingFile === c.file_name ? (
            <input
              className="activation-cache-rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              disabled={saving}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleRename(c);
                if (e.key === "Escape") {
                  setRenamingFile(null);
                  setRenameValue("");
                }
              }}
            />
          ) : (
            <span className="activation-cache-name">{c.name}</span>
          )}
          {(c.description || c.domain || c.language || c.author || c.signed) && renamingFile !== c.file_name ? (
            <span className="activation-cache-meta">{metaLine(c)}</span>
          ) : null}
        </label>
      ) : (
        <label className="activation-cache-item">
          <span className="activation-cache-name">
            {c.name} · {t("cache.quarantineBadge")}
          </span>
          {(c.description || c.domain || c.language || c.author || c.signed) ? (
            <span className="activation-cache-meta">{metaLine(c)}</span>
          ) : null}
        </label>
      )}
      <div className="activation-cache-item-actions">
        {isQuarantined ? (
          <>
            <button
              type="button"
              className="skills-btn"
              disabled={saving}
              onClick={() => void handleAccept(c)}
            >
              {t("cache.accept")}
            </button>
            <button
              type="button"
              className="skills-btn skills-btn-danger"
              disabled={saving}
              onClick={() => void handleDelete(c, true)}
            >
              {t("common.delete")}
            </button>
          </>
        ) : renamingFile === c.file_name ? (
          <>
            <button
              type="button"
              className="skills-btn"
              disabled={saving || !renameValue.trim()}
              onClick={() => void handleRename(c)}
            >
              {t("common.save")}
            </button>
            <button
              type="button"
              className="skills-btn"
              disabled={saving}
              onClick={() => {
                setRenamingFile(null);
                setRenameValue("");
              }}
            >
              {t("common.cancel")}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="skills-btn"
              disabled={saving}
              onClick={() => {
                setRenamingFile(c.file_name);
                setRenameValue(c.name);
              }}
            >
              {t("cache.rename")}
            </button>
            <button
              type="button"
              className="skills-btn skills-btn-danger"
              disabled={saving}
              onClick={() => void handleDelete(c, false)}
            >
              {t("common.delete")}
            </button>
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="cabinet-section">
      <h3 className="cabinet-section-title">{t("cache.title")}</h3>
      <p className="cabinet-section-desc">{t("cache.desc")}</p>
      {error && (
        <p className="cabinet-error" role="alert">
          {error}
        </p>
      )}
      {!error && notice && (
        <p className="cabinet-section-desc" role="status">
          {notice}
        </p>
      )}

      <div className="activation-cache-path">
        <label>
          <span>{t("cache.pathLabel")}</span>
          <input
            type="text"
            value={cacheStorePath}
            onChange={(e) => setCacheStorePath(e.target.value)}
            placeholder={t("cache.pathPlaceholder")}
            disabled={saving}
          />
        </label>
        {isDesktop && window.claw2Desktop?.pickDirectory ? (
          <button
            type="button"
            className="skills-btn"
            onClick={() => void handleBrowseDirectory()}
            disabled={saving}
          >
            {t("cache.browseDir")}
          </button>
        ) : null}
        <button type="button" className="skills-btn" onClick={() => void handleSavePath()} disabled={saving}>
          {saving ? t("common.saving") : t("cache.saveRefresh")}
        </button>
      </div>

      <div className="activation-cache-file">
        <div className="activation-cache-file-label">{t("cache.fileLabel")}</div>
        <div className="activation-cache-file-row">
          <code className="activation-cache-file-value" title={pendingFile}>
            {pendingFile || t("cache.fileNone")}
          </code>
          {isDesktop && window.claw2Desktop?.pickFile ? (
            <button type="button" className="skills-btn" onClick={() => void handlePickCacheFile()} disabled={saving}>
              {t("cache.browseFile")}
            </button>
          ) : null}
        </div>
        <p className="cabinet-section-desc activation-cache-file-hint">{t("cache.fileHint")}</p>
      </div>

      <div className="activation-cache-list" role="radiogroup" aria-label={t("cache.pickAria")}>
        <label className="activation-cache-item">
          <input
            type="radio"
            name="activationCache"
            checked={selectedId === null}
            onChange={() => void handleSelect(null)}
            disabled={saving}
          />
          <span>{t("cache.none")}</span>
        </label>
        {caches.map((c) => cacheRow(c, false))}
      </div>
      {caches.length === 0 && cacheStorePath.trim() && (
        <p className="cabinet-section-desc">{t("cache.emptyDir")}</p>
      )}

      {quarantined.length > 0 ? (
        <div className="activation-cache-list">
          <div className="activation-cache-file-label">{t("cache.quarantineTitle")}</div>
          <p className="cabinet-section-desc activation-cache-file-hint">{t("cache.quarantineHint")}</p>
          {quarantined.map((c) => cacheRow(c, true))}
        </div>
      ) : null}
    </div>
  );
}
