// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import type { ReactNode } from "react";
import { t } from "../i18n";

/** File extension */
function getExtension(filename: string): string {
  return filename.includes(".") ? filename.slice(filename.lastIndexOf(".")).toLowerCase() : "";
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

export function isImageFileName(filename: string): boolean {
  return IMAGE_EXTENSIONS.has(getExtension(filename));
}

export function isImageFile(file: File): boolean {
  if (file.type?.startsWith("image/")) return true;
  return isImageFileName(file.name);
}

/** Tooltip hint from file extension */
export function getFileTypeLabel(filename: string): string {
  const ext = getExtension(filename);
  const map: Record<string, ReturnType<typeof t>> = {
    ".pdf": t("file.pdf"), ".doc": t("file.doc"), ".docx": t("file.docx"),
    ".xls": t("file.xls"), ".xlsx": t("file.xlsx"), ".txt": t("file.txt"),
    ".md": t("file.md"), ".json": t("file.json"), ".csv": t("file.csv"),
    ".xml": t("file.xml"), ".html": t("file.html"), ".htm": t("file.html"),
    ".png": t("file.png"), ".jpg": t("file.jpg"), ".jpeg": t("file.jpg"),
    ".gif": t("file.gif"), ".webp": t("file.webp"), ".zip": t("file.zip"), ".rtf": t("file.rtf"),
  };
  return map[ext] || (ext ? t("file.genericExt", { ext }) : t("file.generic"));
}

const IMAGE_FILE_ICON = (s: number) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="chat-file-icon" aria-hidden>
    <path d="M5 2h9l5 5v14H5V2z" fill="#E8E8E8" stroke="#B0B0B0" strokeWidth="1.2" />
    <path d="M14 2v5h5" fill="#E8E8E8" stroke="#B0B0B0" strokeWidth="1.2" />
    <rect x="7" y="9" width="10" height="8" rx="1" fill="#9B59B6" opacity="0.9" />
    <circle cx="10" cy="12" r="1.8" fill="white" />
    <path d="M7 17l3-3 2 2 3-4 2 3" stroke="white" strokeWidth="1" fill="none" />
  </svg>
);

/** File icon by extension (standard type colors) */
export function FileIcon({ filename, size = 20 }: { filename: string; size?: number }) {
  const ext = getExtension(filename);
  const s = size;
  const doc = (color: string) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="chat-file-icon" aria-hidden>
      <path d="M5 2h9l5 5v14H5V2z" fill="#E8E8E8" stroke="#B0B0B0" strokeWidth="1.2" />
      <path d="M14 2v5h5" fill="#E8E8E8" stroke="#B0B0B0" strokeWidth="1.2" />
      <rect x="6" y="10" width="12" height="1.5" rx="0.5" fill={color} />
    </svg>
  );
  const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
  if (imageExts.includes(ext)) return IMAGE_FILE_ICON(s);
  const icons: Record<string, ReactNode> = {
    ".pdf": doc("#C41E3A"),
    ".doc": doc("#2B579A"),
    ".docx": doc("#2B579A"),
    ".xls": doc("#217346"),
    ".xlsx": doc("#217346"),
    ".csv": doc("#217346"),
    ".txt": doc("#6B6B6B"),
    ".md": doc("#6B6B6B"),
    ".json": doc("#F5DE19"),
    ".xml": doc("#E34F26"),
    ".html": doc("#E34F26"),
    ".htm": doc("#E34F26"),
    ".rtf": doc("#6B6B6B"),
    ".zip": (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="chat-file-icon" aria-hidden>
        <path d="M5 2h9l5 5v14H5V2z" fill="#E8E8E8" stroke="#B0B0B0" strokeWidth="1.2" />
        <path d="M14 2v5h5" fill="#E8E8E8" stroke="#B0B0B0" strokeWidth="1.2" />
        <path d="M8 10h8v1.5H8V10zm0 3h8v1.5H8V13zm0 3h5v1.5H8V16z" fill="#F5A623" />
      </svg>
    ),
  };
  const node = icons[ext];
  if (node) return <>{node}</>;
  return doc("#6B6B6B");
}
