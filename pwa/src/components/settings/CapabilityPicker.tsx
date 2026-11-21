// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { useState } from "react";
import { STANDARD_CAPS, parseNotes, serializeNotes, toggleToken, renameToken } from "../../utils/capabilities";

/**
 * Capability checklist for the provider card: standard checkboxes + custom
 * tokens (rename/delete) + a free-input row to add new ones. The list is
 * stored as the comma-separated notes string; "Изображения (vision)" is a
 * separate checkbox bound to the vision flag (hard router rule).
 */
export function CapabilityPicker({
  notes,
  vision,
  onChange,
}: {
  notes: string;
  vision: boolean;
  onChange: (next: { notes: string; vision: boolean }) => void;
}) {
  const tokens = parseNotes(notes);
  const lowered = tokens.map((t) => t.toLowerCase());
  const [adding, setAdding] = useState("");
  const [editFrom, setEditFrom] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const setTokens = (next: string[]) => onChange({ notes: serializeNotes(next), vision });
  const toggle = (cap: string) => setTokens(toggleToken(tokens, cap));

  const standardChecked = (cap: string) => lowered.includes(cap.toLowerCase());

  const custom = tokens.filter((t) => !STANDARD_CAPS.some((s) => s.toLowerCase() === t.toLowerCase()));

  const addCustom = () => {
    const token = adding.trim();
    if (!token) return;
    setTokens(toggleToken(tokens, token));
    setAdding("");
  };

  const selectedCount = tokens.length + (vision ? 1 : 0);

  return (
    <details className="cap-fold">
      <summary className="cap-fold-summary">
        <span>Возможности модели</span>
        <span className="cap-fold-count">{selectedCount}</span>
      </summary>
      <div className="cap-list">
        {STANDARD_CAPS.map((cap) => (
          <label key={cap} className="cap-item">
            <input
              type="checkbox"
              checked={standardChecked(cap)}
              onChange={() => toggle(cap)}
            />
            <span>{cap}</span>
          </label>
        ))}
        <label className="cap-item">
          <input
            type="checkbox"
            checked={vision}
            onChange={(e) => onChange({ notes, vision: e.target.checked })}
          />
          <span>изображения (vision)</span>
        </label>
        {custom.map((token) => (
          <div key={token.toLowerCase()} className="cap-custom">
            {editFrom === token.toLowerCase() ? (
              <span className="cap-edit-row">
                <input
                  type="text"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      setTokens(renameToken(tokens, token, editValue));
                      setEditFrom(null);
                    }
                  }}
                  autoFocus
                />
                <button
                  type="button"
                  aria-label="Сохранить"
                  onClick={() => {
                    const next = editValue.trim();
                    if (next) setTokens(renameToken(tokens, token, next));
                    setEditFrom(null);
                  }}
                >
                  ✓
                </button>
                <button type="button" aria-label="Отмена" onClick={() => setEditFrom(null)}>
                  ✕
                </button>
              </span>
            ) : (
              <span className="cap-custom-row">
                <label className="cap-item">
                  <input type="checkbox" checked onChange={() => toggle(token)} />
                  <span>{token}</span>
                </label>
                <button
                  type="button"
                  className="cap-mini-btn"
                  aria-label={`Изменить «${token}»`}
                  onClick={() => {
                    setEditFrom(token.toLowerCase());
                    setEditValue(token);
                  }}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="cap-mini-btn"
                  aria-label={`Удалить «${token}»`}
                  onClick={() => setTokens(toggleToken(tokens, token))}
                >
                  ✕
                </button>
              </span>
            )}
          </div>
        ))}
        <div className="cap-add-row">
          <input
            type="text"
            value={adding}
            placeholder="Своя характеристика…"
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addCustom();
              }
            }}
          />
          <button type="button" onClick={addCustom} disabled={!adding.trim()} aria-label="Добавить характеристику">
            +
          </button>
        </div>
        <div className="cap-picker-hint">
          Попадает в промпт модели-роутера. «изображения (vision)» — жёсткое правило: с картинками
          кандидаты только среди vision-провайдеров.
        </div>
      </div>
    </details>
  );
}
