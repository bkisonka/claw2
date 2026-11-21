// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";

interface ImageEditDialogProps {
  imageName: string;
  previewSrc?: string;
  onCancel: () => void;
  onSubmit: (edits: string) => void;
}

/** Image edit dialog (window.prompt does not work in Electron). */
export function ImageEditDialog({ imageName, previewSrc, onCancel, onSubmit }: ImageEditDialogProps) {
  const t = useT();
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onCancel]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  return createPortal(
    <div className="image-edit-dialog-backdrop" onClick={onCancel} role="presentation">
      <div
        className="image-edit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId} className="image-edit-dialog-title">
          {t("gallery.editTitle")}
        </h3>
        <p className="image-edit-dialog-name" title={imageName}>
          {imageName}
        </p>
        {previewSrc ? (
          <div className="image-edit-dialog-preview">
            <img src={previewSrc} alt="" />
          </div>
        ) : null}
        <label className="image-edit-dialog-label" htmlFor="image-edit-input">
          {t("gallery.editPromptAsk")}
        </label>
        <textarea
          id="image-edit-input"
          ref={inputRef}
          className="image-edit-dialog-input"
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("gallery.editPlaceholder")}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="image-edit-dialog-actions">
          <button type="button" className="image-edit-dialog-btn" onClick={onCancel}>
            {t("gallery.editCancel")}
          </button>
          <button
            type="button"
            className="image-edit-dialog-btn image-edit-dialog-btn-primary"
            disabled={!text.trim()}
            onClick={submit}
          >
            {t("gallery.editSubmit")}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
