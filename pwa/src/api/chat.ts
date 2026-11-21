// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Chat API facade — now backed by the in-app engine (IndexedDB + direct LLM),
 * keeping the exact interface the UI components use.
 */
import {
  appendMessage,
  chatFiles,
  deleteChat as dbDeleteChat,
  ensureChat,
  getChat,
  getHistory,
  getPromptContext,
  listChats,
  setPromptContext,
  type StoredMessage,
} from "../engine/db";
import { runAgentTurn, type Attachment } from "../engine/agent";
import {
  base64ToBlob,
  deleteFile,
  deleteFilesOfChat,
  getFileById,
  isStoredFileUrl,
  listFiles,
  resolveStoredFileUrl,
  saveFile,
  storedFileIdFromUrl,
} from "../engine/files";
import { inferMimeFromName } from "../engine/mime";
import { buildChatMarkdown, markdownFileName } from "../engine/chat-markdown";
import { summarizeWithLlm } from "../engine/context";
import { toolRemember } from "../engine/tools";
import { getSettings } from "../engine/settings";
import { isNative } from "../native";

export interface ChatListItemApi {
  id: string;
  title: string;
  updated_at: number;
}

export interface HistoryMessageApi {
  role: "user" | "assistant";
  content: string;
  cells?: ChatCell[];
  /** Metadata only — binaries resolve lazily through /files/raw/<id>. */
  attachedFiles?: { name: string; deleted?: boolean }[];
}

export interface ChatCell {
  type: string;
  content: string;
}

export interface ChatResponse {
  content: string;
  sessionId: string;
  error?: string;
  lastRunId?: number;
  cells?: ChatCell[];
  userCells?: ChatCell[];
  contextCompressed?: number;
  /** Router info for the feed meta line; null when routing is off. */
  routed?: { id: string; name: string; model: string; pinned: boolean; why: string } | null;
}

export interface DocumentToSend {
  name: string;
  contentBase64: string;
  mimeType?: string;
}

export interface ChatDocumentItem {
  url: string;
  name: string;
  path: string;
  ext: string;
  /** False for user attachments (part of the tape); true for agent-saved files. */
  deletable?: boolean;
}

export async function fetchChatList(q?: string): Promise<ChatListItemApi[]> {
  return listChats(q);
}

export async function fetchChatHistory(sessionId: string): Promise<HistoryMessageApi[]> {
  // No binaries cross this boundary: cells keep their /files/raw/<id> refs
  // (rendered lazily), attachments are metadata. Opening a chat costs O(metadata).
  const msgs = await getHistory(sessionId);
  return msgs.map((m) => ({
    role: m.role,
    content: m.content,
    cells: m.cells,
    attachedFiles: m.attachedFiles?.map((f) => ({
      name: f.name,
      deleted: f.deleted,
    })),
  }));
}

export async function deleteChat(sessionId: string): Promise<boolean> {
  await dbDeleteChat(sessionId);
  await deleteFilesOfChat(sessionId);
  return true;
}

export async function fetchChatDocuments(sessionId: string): Promise<ChatDocumentItem[]> {
  // All binaries (agent files AND user attachments) live in the files store.
  // Attachments are listed from message metadata (original names, deletion
  // flag) but flagged non-deletable: they are part of the tape.
  const stored = await listFiles(sessionId);
  const attachments = new Map((await chatFiles(sessionId)).map((f) => [f.fileId, f]));
  return stored.map((f) => {
    const att = attachments.get(f.id);
    const name = att?.name ?? f.name;
    const url = `/files/raw/${f.id}`;
    const ext = (name.split(".").pop() ?? "").toLowerCase();
    return { url, name, path: url, ext, deletable: !att };
  });
}

/** Resolve a stored-file reference (/files/raw/<id>) to a data: URL; pass through others. */
export async function resolveToDataUrl(pathOrUrl: string): Promise<string> {
  if (isStoredFileUrl(pathOrUrl)) {
    const resolved = await resolveStoredFileUrl(pathOrUrl);
    if (resolved) return resolved;
  }
  return pathOrUrl;
}

/**
 * Delete an agent-saved session file (Документы/Картинки tabs) by its
 * /files/raw/<id> reference. False when the reference is not a stored file.
 * Chat messages that referenced it fall back to their "не удалось загрузить"
 * cell view — the record in the tape stays, the binary is gone.
 */
export async function deleteChatFile(pathOrUrl: string): Promise<boolean> {
  const id = storedFileIdFromUrl(pathOrUrl);
  if (!id) return false;
  await deleteFile(id);
  return true;
}

/** data: URLs pass through; anything else is returned as-is. */
export function fileDownloadUrl(pathOrUrl: string): string {
  return pathOrUrl;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      resolve(dataUrl.includes(",") ? (dataUrl.split(",")[1] ?? "") : "");
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Native app: write to cache and open the system share sheet (Save to Files, Drive…). */
async function shareFileNative(blob: Blob, filename: string): Promise<void> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const { Share } = await import("@capacitor/share");
  const safeName = filename.replace(/[\\/]/g, "-").slice(-120) || "file";
  const written = await Filesystem.writeFile({
    path: safeName,
    data: await blobToBase64(blob),
    directory: Directory.Cache,
  });
  // files (EXTRA_STREAM), NOT url: url shares a text link — "Save to Files"
  // and messengers would receive a string instead of the actual file.
  await Share.share({ title: filename, files: [written.uri], dialogTitle: filename });
}

/** Deliver a generated blob: native share sheet, else Web Share, else download. */
async function deliverBlob(blob: Blob, filename: string): Promise<void> {
  if (isNative()) {
    await shareFileNative(blob, filename);
    return;
  }
  const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
  const nav = navigator as Navigator & {
    canShare?: (data?: ShareData) => boolean;
    share?: (data: ShareData) => Promise<void>;
  };
  if (typeof nav.share === "function" && typeof nav.canShare === "function") {
    try {
      if (nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: filename });
        return;
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
    }
  }
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
}

export async function downloadChatFile(pathOrUrl: string, filename: string): Promise<void> {
  const id = storedFileIdFromUrl(pathOrUrl);
  let blob: Blob;
  if (id) {
    // Direct decode — fetch(dataUrl) would copy the bytes twice more.
    const f = await getFileById(id);
    if (!f) throw new Error("Файл не найден");
    blob = base64ToBlob(f.mimeType, f.base64);
  } else {
    const res = await fetch(await resolveToDataUrl(pathOrUrl));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    blob = await res.blob();
  }
  await deliverBlob(blob, filename);
}

/**
 * Chat export ("Экспорт в MD", the desktop counterpart): whole tape from
 * IndexedDB into a .md file, delivered via the system share sheet.
 */
export async function exportChatToMarkdown(sessionId: string, title: string): Promise<void> {
  const msgs = await getHistory(sessionId);
  const markdown = buildChatMarkdown({
    title: title || "Чат",
    messages: msgs.map((m) => ({
      role: m.role,
      content: m.content,
      cells: m.cells,
      attachedFiles: m.attachedFiles,
      createdAt: m.createdAt,
    })),
  });
  await deliverBlob(
    new Blob([markdown], { type: "text/markdown; charset=utf-8" }),
    markdownFileName(title)
  );
}

export interface StreamSnapshot {
  text: string;
  cells: ChatCell[];
  /** Set while a tool is executing — the feed shows the activity. */
  tool?: string;
}

/**
 * Background summarizes run per chat in submission order: two overlapping turns
 * must not write promptContext out of order (the older recap would overwrite
 * the newer one — a read-modify-write race on the chat record).
 */
const summarizeQueues = new Map<string, Promise<void>>();

function enqueueSummarize(chatId: string, job: () => Promise<void>): void {
  const prev = summarizeQueues.get(chatId) ?? Promise.resolve();
  const next = prev.then(job, job);
  summarizeQueues.set(
    chatId,
    next.finally(() => {
      if (summarizeQueues.get(chatId) === next) summarizeQueues.delete(chatId);
    })
  );
}

export async function sendMessageStream(
  message: string,
  sessionId: string | undefined,
  documents: DocumentToSend[] | undefined,
  onChunk: (snap: StreamSnapshot) => void,
  signal?: AbortSignal
): Promise<ChatResponse> {
  const chatId = await ensureChat(sessionId ?? "", message);
  const history: StoredMessage[] = await getHistory(chatId);
  const promptContext = await getPromptContext(chatId);
  const attachments: Attachment[] = (documents ?? []).map((d) => ({
    name: d.name,
    contentBase64: d.contentBase64,
    mimeType: d.mimeType,
  }));
  // Binaries go to the files store; the message keeps metadata. The tape and
  // every history reload read names/ids only — no base64 crosses IDB here.
  const savedAttachments: { name: string; fileId: string; mimeType?: string }[] = [];
  for (const a of attachments) {
    const meta = await saveFile(chatId, a.name, a.mimeType || "application/octet-stream", a.contentBase64, "attachment");
    savedAttachments.push({ name: a.name, fileId: meta.id, mimeType: a.mimeType });
  }
  // Inline preview of the user's images: stable /files/raw refs, PERSISTED on
  // the message — the tape shows attached images after reloads too, not just
  // right after sending (files resolve lazily at render).
  const userCells: ChatCell[] = savedAttachments
    .filter((a) => (a.mimeType || inferMimeFromName(a.name) || "").startsWith("image/"))
    .map((a) => ({ type: "image", content: `/files/raw/${a.fileId}` }));

  await appendMessage({
    chatId,
    role: "user",
    content: message,
    cells: userCells.length ? userCells : undefined,
    attachedFiles: savedAttachments.length ? savedAttachments : undefined,
    createdAt: Date.now(),
  });

  let streamed = "";
  const res = await runAgentTurn({
    chatId,
    history,
    promptContext,
    userText: message,
    attachments,
    signal,
    onEvent: (e) => {
      if (e.type === "stream") {
        streamed = e.text;
        onChunk({ text: e.text, cells: e.cells });
      } else if (e.type === "tool") {
        // Tool activity surfaces in the feed — a model that only *claims* it
        // saved something must be distinguishable from one that did.
        onChunk({ text: streamed, cells: [], tool: e.name });
      }
    },
  });

  // Context compression runs in the background — never blocks the reply.
  // Queued per chat so concurrent turns cannot interleave their writes.
  if (res.backgroundSummarize) {
    const plan = res.backgroundSummarize;
    enqueueSummarize(chatId, async () => {
      try {
        const summary = await summarizeWithLlm(plan.text);
        if (!summary) return;
        await setPromptContext(chatId, summary, plan.coveredCount);
        if (getSettings().memory.enabled) {
          await toolRemember(summary, "internal").catch(() => {});
        }
      } catch {
        /* best effort */
      }
    });
  }

  // The chat may have been deleted while the turn was running — do not
  // resurrect it (appendMessage would create orphan messages touchChat skips).
  if (!(await getChat(chatId))) {
    return {
      content: res.content || streamed,
      sessionId: chatId,
      cells: undefined,
      userCells: undefined,
      routed: res.routed,
    };
  }

  await appendMessage({
    chatId,
    role: "assistant",
    content: res.content,
    cells: res.cells.length ? res.cells : undefined,
    createdAt: Date.now(),
  });

  return {
    content: res.content || streamed,
    sessionId: chatId,
    // Cells keep their /files/raw refs — Chat renders media lazily.
    cells: res.cells.length ? res.cells : undefined,
    userCells: userCells.length ? userCells : undefined,
    routed: res.routed,
  };
}

export function readFileAsBase64(file: File): Promise<DocumentToSend> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] ?? "" : "";
      resolve({
        name: file.name,
        contentBase64: base64,
        // Android pickers often report File.type === "" — recover from the name.
        mimeType: file.type || inferMimeFromName(file.name) || undefined,
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
