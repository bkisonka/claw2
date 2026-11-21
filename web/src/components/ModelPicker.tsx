// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchLlmModels } from "../api/llmModels";
import { getConfig } from "../api/config";
import { updateChatModel } from "../api/chat";
import { useT } from "../i18n";
import { IconCheck } from "./icons";

export type ModelPickerProps = {
  /** When set, selection is stored on this chat (settings default stays unchanged). */
  sessionId?: string | null;
  /** Chat override; null/undefined = follow settings default. */
  chatModel?: string | null;
  onChatModelChange?: (model: string | null) => void;
};

export function ModelPicker({ sessionId, chatModel = null, onChatModelChange }: ModelPickerProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [defaultModel, setDefaultModel] = useState("");
  const [override, setOverride] = useState<string | null>(chatModel?.trim() || null);
  const [models, setModels] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    // Don't clobber an in-flight optimistic selection with a stale null prop.
    if (savingRef.current) return;
    setOverride(chatModel?.trim() || null);
  }, [chatModel, sessionId]);

  useEffect(() => {
    getConfig()
      .then((c) => {
        const llm = c.llm as { model?: string } | undefined;
        if (typeof llm?.model === "string" && llm.model.trim()) {
          setDefaultModel(llm.model.trim());
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const id = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  const loadModels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchLlmModels();
      if (res.current) setDefaultModel(res.current);
      setModels(res.models);
      if (res.error && res.models.length === 0) setError(res.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("chat.manageModelsError"));
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void loadModels();
  };

  const effective = override || defaultModel;
  const sid = sessionId?.trim() || "";

  const select = async (id: string) => {
    const next = id.trim();
    if (!next || savingRef.current) return;
    if (next === override) {
      setOpen(false);
      return;
    }
    if (!sid) {
      setError(t("chat.manageModelsError"));
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    // Optimistic — label must update even if the response omits `model`.
    setOverride(next);
    onChatModelChange?.(next);
    try {
      const saved = await updateChatModel(sid, next);
      const applied = saved?.trim() || next;
      setOverride(applied);
      onChatModelChange?.(applied);
      setOpen(false);
    } catch (err) {
      // Roll back
      const prev = chatModel?.trim() || null;
      setOverride(prev);
      onChatModelChange?.(prev);
      setError(err instanceof Error ? err.message : t("chat.manageModelsError"));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const clearOverride = async () => {
    if (!sid || !override || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    const prev = override;
    setOverride(null);
    onChatModelChange?.(null);
    try {
      await updateChatModel(sid, null);
      setOpen(false);
    } catch (err) {
      setOverride(prev);
      onChatModelChange?.(prev);
      setError(err instanceof Error ? err.message : t("chat.manageModelsError"));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return models;
    return models.filter((id) => id.toLowerCase().includes(q));
  }, [models, q]);

  const label = effective || t("chat.manageModels");
  const usingOverride = Boolean(override);
  const defaultLabel = defaultModel
    ? t("chat.manageModelsUseDefault", { model: defaultModel })
    : t("chat.manageModelsUseDefaultShort");
  const defaultMatchesQuery =
    !q ||
    defaultLabel.toLowerCase().includes(q) ||
    defaultModel.toLowerCase().includes(q) ||
    "default".includes(q) ||
    "умолчан".includes(q);
  // When following settings default, hide that id from the plain list (shown via default row).
  // When overridden, hide the override id (shown as current) but keep defaultModel in list if different.
  const others = filtered.filter((id) => {
    if (usingOverride) return id !== override;
    return id !== defaultModel;
  });

  return (
    <div className="chat-model-picker" ref={rootRef}>
      <button
        type="button"
        className={`chat-manage-models${usingOverride ? " chat-manage-models--override" : ""}`}
        onClick={toggle}
        title={
          usingOverride
            ? t("chat.manageModelsChatTitle", { model: effective })
            : t("chat.manageModelsTitle")
        }
        aria-label={t("chat.manageModelsTitle")}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={saving}
      >
        <span className="chat-model-picker-label">{label}</span>
        <span className="chat-model-picker-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="chat-model-menu" role="listbox" aria-label={t("chat.manageModelsTitle")}>
          <div className="chat-model-menu-head">
            <div className="chat-model-menu-search-wrap">
              <input
                ref={searchRef}
                type="search"
                className="chat-model-menu-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("chat.manageModelsSearch")}
                aria-label={t("chat.manageModelsSearch")}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            {!loading && usingOverride && effective && (!q || effective.toLowerCase().includes(q)) ? (
              <button
                type="button"
                role="option"
                aria-selected
                className="chat-model-menu-item chat-model-menu-item--active chat-model-menu-item--current"
                disabled
              >
                <span className="chat-model-menu-item-check" aria-hidden>
                  <IconCheck size={14} />
                </span>
                <span className="chat-model-menu-item-id">{effective}</span>
              </button>
            ) : null}
            {!loading && defaultMatchesQuery ? (
              <button
                type="button"
                role="option"
                aria-selected={!usingOverride}
                className={`chat-model-menu-item chat-model-menu-item--default${!usingOverride ? " chat-model-menu-item--active chat-model-menu-item--current" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (usingOverride) void clearOverride();
                  else setOpen(false);
                }}
                disabled={saving || !defaultModel}
              >
                <span
                  className={`chat-model-menu-item-check${!usingOverride ? "" : " chat-model-menu-item-check--empty"}`}
                  aria-hidden
                >
                  {!usingOverride ? <IconCheck size={14} /> : null}
                </span>
                <span className="chat-model-menu-item-id">{defaultLabel}</span>
              </button>
            ) : null}
            {!loading ? <div className="chat-model-menu-divider" role="separator" /> : null}
          </div>
          {loading && <div className="chat-model-menu-status">{t("chat.manageModelsLoading")}</div>}
          {!loading && error && <div className="chat-model-menu-status chat-model-menu-error">{error}</div>}
          {!loading && !error && models.length === 0 && (
            <div className="chat-model-menu-status">{t("chat.manageModelsEmpty")}</div>
          )}
          {!loading && !error && models.length > 0 && others.length === 0 && filtered.length === 0 && (
            <div className="chat-model-menu-status">{t("chat.manageModelsNoMatch")}</div>
          )}
          {!loading &&
            others.map((id) => (
              <button
                key={id}
                type="button"
                role="option"
                aria-selected={false}
                className="chat-model-menu-item"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void select(id)}
                disabled={saving}
              >
                <span className="chat-model-menu-item-check chat-model-menu-item-check--empty" aria-hidden />
                <span className="chat-model-menu-item-id">{id}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
