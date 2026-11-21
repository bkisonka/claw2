// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Virtual session files — the mobile counterpart of agents/output + /files/.
 * Documents/images the agent saves live in IndexedDB and surface in the
 * session's Документы/Картинки tabs (share/download via Capacitor).
 */
import { deleteByIndex, tx } from "./db";

export type StoredFile = {
  id: string;
  chatId: string;
  name: string;
  mimeType: string;
  base64: string;
  createdAt: number;
  /** "attachment" — user upload referenced by a message; "agent" — model-saved. */
  source?: "attachment" | "agent";
};

export type FileMeta = Omit<StoredFile, "base64">;

const FILE_ID_RE = /^file_[0-9a-z_]+$/i;

function toMeta(f: StoredFile): FileMeta {
  const { base64: _b, ...meta } = f;
  return meta;
}

function dataUrlOf(f: StoredFile): string {
  return `data:${f.mimeType};base64,${f.base64}`;
}

export function isStoredFileUrl(url: string): boolean {
  return /^\/files\/(raw\/)?file_/i.test(url) || FILE_ID_RE.test(url);
}

/** Extract the file id from /files/raw/<id>, /files/<id> or a bare id; null otherwise. */
export function storedFileIdFromUrl(url: string): string | null {
  const id = url.replace(/^\/files\/(raw\/)?/i, "").split("?")[0];
  return FILE_ID_RE.test(id) ? id : null;
}

/** Resolve /files/raw/<id>, /files/<id> or a bare file id to a data: URL. */
export async function resolveStoredFileUrl(url: string): Promise<string | null> {
  const id = storedFileIdFromUrl(url);
  if (!id) return null;
  const f = await tx<StoredFile | undefined>("files", "readonly", (s) => s.get(id));
  return f ? dataUrlOf(f) : null;
}

export async function saveFile(
  chatId: string,
  name: string,
  mimeType: string,
  base64: string,
  source: StoredFile["source"] = "agent"
): Promise<FileMeta> {
  const safe = name.replace(/[\\/\0]/g, "_").trim() || `file_${Date.now()}`;
  const id = `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const rec: StoredFile = { id, chatId, name: safe, mimeType, base64, createdAt: Date.now(), source };
  await tx("files", "readwrite", (s) => s.put(rec));
  return toMeta(rec);
}

export async function listFiles(chatId: string): Promise<FileMeta[]> {
  const all =
    (await tx<StoredFile[]>("files", "readonly", (s) => (s.index("chatId") as IDBIndex).getAll(chatId))) ?? [];
  return all.sort((a, b) => a.createdAt - b.createdAt).map(toMeta);
}

export async function getFile(chatId: string, nameOrId: string): Promise<StoredFile | null> {
  if (FILE_ID_RE.test(nameOrId)) {
    const byId = await tx<StoredFile | undefined>("files", "readonly", (s) => s.get(nameOrId));
    if (byId && byId.chatId === chatId) return byId;
  }
  const lower = nameOrId.toLowerCase();
  const all =
    (await tx<StoredFile[]>("files", "readonly", (s) => (s.index("chatId") as IDBIndex).getAll(chatId))) ?? [];
  return all.find((f) => f.name.toLowerCase() === lower) ?? null;
}

/** Fetch a stored file by id alone (downloads, media previews). */
export async function getFileById(id: string): Promise<StoredFile | null> {
  if (!FILE_ID_RE.test(id)) return null;
  const f = await tx<StoredFile | undefined>("files", "readonly", (s) => s.get(id));
  return f ?? null;
}

export async function deleteFile(id: string): Promise<void> {
  if (!FILE_ID_RE.test(id)) return;
  await tx("files", "readwrite", (s) => s.delete(id));
}

export async function deleteFilesOfChat(chatId: string): Promise<void> {
  await deleteByIndex("files", "chatId", chatId);
}

export function fileDataUrl(f: StoredFile): string {
  return dataUrlOf(f);
}

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  // Chunked conversion: one 15MB text as char-by-char concatenation kept the
  // main thread busy far longer than the (single) rope-friendly batch calls.
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

/** Raw base64 → Blob without the data: URL string round-trip. */
export function base64ToBlob(mimeType: string, base64: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mimeType || "application/octet-stream" });
}

const DATA_URL_RE = /^data:([^;,]*)(;base64)?,([\s\S]*)$/;

/**
 * Split a base64 data: URL into mime + raw base64. Null for non-base64 or
 * malformed payloads — callers keep those inline rather than guessing.
 */
export function parseDataUrlToBase64(dataUrl: string): { mimeType: string; base64: string } | null {
  const m = dataUrl.match(DATA_URL_RE);
  if (!m || !m[2]) return null;
  const base64 = m[3].replace(/\s/g, "");
  if (!base64) return null;
  return { mimeType: m[1] || "application/octet-stream", base64 };
}
