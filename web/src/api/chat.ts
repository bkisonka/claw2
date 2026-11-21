// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { apiBase, apiKey } from "../config";
import { getAuthHeaders } from "../auth/storage";

/** Chat list item from the API (id, title, updated_at, project_id). */
export interface ChatListItemApi {
  id: string;
  title: string;
  updated_at: number;
  project_id?: string | null;
  browser_page_key?: string | null;
  /** Per-chat model override; null/absent = settings default. */
  model?: string | null;
  pinned?: boolean;
  favorited?: boolean;
}

/** Message from GET /chat/history. */
export interface HistoryMessageApi {
  role: "user" | "assistant";
  content: string;
  meta?: string;
  cells?: ChatCell[];
  attachedFiles?: { name: string; previewUrl?: string; deleted?: boolean }[];
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
  /** Inline cells for chat display (calendars, charts). content uses placeholders [CELL_0], [CELL_1], ... */
  cells?: ChatCell[];
  /** Images from user attachments (persistent /files/uploads/…). */
  userCells?: ChatCell[];
  /** How many messages were folded into the prompt summary this turn (request context compression). */
  contextCompressed?: number;
  /** The model updated the contextual sidebar. */
  sidebarUpdated?: boolean;
  /** Dialogue Insights offer (ask/auto); not part of transcript until accepted. */
  insightOffer?: InsightOfferApi | null;
}

export type InsightReasonCodeApi =
  | "pattern"
  | "position_shift"
  | "solution_transfer"
  | "unresolved_thread";

export interface InsightOfferApi {
  offerId: string;
  reasonCode: InsightReasonCodeApi;
  pastChatId: string;
  pastChatTitle: string;
  pastChatUpdatedAt: number;
  score?: number;
  insightTopic: string;
  excerpts: string[];
  askTemplateKey: "semantic_link" | "unresolved_return";
  text?: string;
}

export interface ClientInsightContextPayload {
  pastChatId: string;
  reasonCode: InsightReasonCodeApi | string;
  insightTopic: string;
  excerpts: string[];
  currentBrief: string;
  pastChatTitle?: string;
  formulatedText?: string;
}

export interface DocumentToSend {
  name: string;
  contentBase64: string;
  mimeType?: string;
}

export interface ChatPageContextPayload {
  /** User text selection (preferred over snippet). */
  text?: string;
  /** Short rendered page snippet when there is no selection. */
  snippet?: string;
  url?: string;
  title?: string;
}

/** Full rendered page text from BrowserView (tool fallback / W snapshot). */
export async function postBrowserPageText(payload: {
  requestId: string;
  url?: string;
  title?: string;
  text: string;
  truncated?: boolean;
}): Promise<{ ok: boolean }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...getAuthHeaders(),
  };
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
    if (!headers["Authorization"]) headers["Authorization"] = `Bearer ${apiKey}`;
  }
  const res = await fetch(`${apiBase}/api/chat/browser-page-text`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
  return { ok: res.ok && data.ok !== false };
}

export async function sendMessage(
  message: string,
  sessionId?: string,
  documents?: DocumentToSend[],
  recognizedUser?: string,
  projectId?: string | null,
  pageContext?: ChatPageContextPayload | null
): Promise<ChatResponse> {
  const url = `${apiBase}/chat`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-User-Id": "default",
  };
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  const body: Record<string, unknown> = {
    message: message.trim(),
    sessionId: sessionId || undefined,
  };
  if (documents && documents.length > 0) {
    body.documents = documents;
  }
  if (recognizedUser && recognizedUser.trim() && recognizedUser.trim().toLowerCase() !== "unknown") {
    body.recognizedUser = recognizedUser.trim();
  }
  if (projectId != null && projectId !== "") {
    body.project_id = projectId;
  }
  if (
    pageContext?.text?.trim() ||
    pageContext?.snippet?.trim() ||
    pageContext?.url?.trim() ||
    pageContext?.title?.trim()
  ) {
    body.pageContext = {
      text: pageContext.text?.trim() || undefined,
      snippet: pageContext.snippet?.trim() || undefined,
      url: pageContext.url?.trim() || undefined,
      title: pageContext.title?.trim() || undefined,
    };
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as ChatResponse & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return {
    content: data.content ?? "",
    sessionId: data.sessionId ?? "",
    error: data.error,
    lastRunId: data.lastRunId,
    cells: data.cells,
    userCells: data.userCells,
    contextCompressed: data.contextCompressed,
  };
}

/** Send a message with a streaming reply. voiceGender — gender from voice (after PTT). voiceEmotion — emotion from voice (after PTT). recognizedUser — camera-recognized user ID (when vision is on). projectId — bind chat to project on create. */
export async function sendMessageStream(
  message: string,
  sessionId: string | undefined,
  documents: DocumentToSend[] | undefined,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  voiceGender?: "male" | "female",
  voiceEmotion?: "angry" | "happy" | "neutral" | "sad",
  recognizedUser?: string,
  projectId?: string | null,
  onSidebarUpdated?: () => void,
  pageContext?: ChatPageContextPayload | null,
  onOpenBrowserUrl?: (url: string) => void,
  chatTitle?: string | null,
  browserPageKey?: string | null,
  clientInsightContext?: ClientInsightContextPayload | null,
  browserPageText?: string | null,
  onReadBrowserPage?: (requestId: string) => void,
  onHeadlessPageText?: (requestId: string, url: string) => void,
  /** Per-chat model override; omit/null = settings default. */
  model?: string | null
): Promise<ChatResponse> {
  const url = `${apiBase}/chat`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-User-Id": "default",
    ...getAuthHeaders(),
  };
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
    if (!headers["Authorization"]) headers["Authorization"] = `Bearer ${apiKey}`;
  }
  const body: Record<string, unknown> = {
    message: message.trim(),
    sessionId: sessionId || undefined,
    stream: true,
  };
  if (model != null && model.trim()) {
    body.model = model.trim();
  }
  if (documents && documents.length > 0) {
    body.documents = documents;
  }
  if (voiceGender) {
    body.voiceGender = voiceGender;
  }
  if (voiceEmotion) {
    body.voiceEmotion = voiceEmotion;
  }
  if (recognizedUser && recognizedUser.trim() && recognizedUser.trim().toLowerCase() !== "unknown") {
    body.recognizedUser = recognizedUser.trim();
  }
  if (projectId != null && projectId !== "") {
    body.project_id = projectId;
  }
  if (chatTitle?.trim()) {
    body.chatTitle = chatTitle.trim();
  }
  if (browserPageKey?.trim()) {
    body.browserPageKey = browserPageKey.trim();
  }
  if (
    pageContext?.text?.trim() ||
    pageContext?.snippet?.trim() ||
    pageContext?.url?.trim() ||
    pageContext?.title?.trim()
  ) {
    body.pageContext = {
      text: pageContext.text?.trim() || undefined,
      snippet: pageContext.snippet?.trim() || undefined,
      url: pageContext.url?.trim() || undefined,
      title: pageContext.title?.trim() || undefined,
    };
  }
  if (clientInsightContext?.pastChatId && clientInsightContext.excerpts?.length) {
    body.clientInsightContext = clientInsightContext;
  }
  if (browserPageText?.trim()) {
    body.browserPageText = browserPageText.trim().slice(0, 16_000);
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  const contentType = res.headers.get("Content-Type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const data = (await res.json().catch(() => ({}))) as ChatResponse & { error?: string };
    return {
      content: data.content ?? "",
      sessionId: data.sessionId ?? "",
      error: data.error,
      lastRunId: data.lastRunId,
      cells: data.cells,
      contextCompressed: data.contextCompressed,
      sidebarUpdated: data.sidebarUpdated,
      insightOffer: data.insightOffer ?? null,
    };
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");
  const decoder = new TextDecoder();
  let buffer = "";
  let final: ChatResponse = { content: "", sessionId: sessionId ?? "" };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const raw = line.slice(6).trim();
          if (raw === "[DONE]" || !raw) continue;
          try {
            const data = JSON.parse(raw) as {
              content?: string;
              done?: boolean;
              sessionId?: string;
              error?: string;
              lastRunId?: number;
              cells?: ChatCell[];
              userCells?: ChatCell[];
              contextCompressed?: number;
              sidebarUpdated?: boolean;
              openBrowserUrl?: string;
              readBrowserPage?: { requestId?: string };
              headlessPageText?: { requestId?: string; url?: string };
              insightOffer?: InsightOfferApi | null;
            };
            if (data.content != null && data.done !== true) {
              onChunk(data.content);
            }
            if (data.sidebarUpdated === true && data.done !== true) {
              onSidebarUpdated?.();
            }
            if (typeof data.openBrowserUrl === "string" && data.openBrowserUrl.trim()) {
              onOpenBrowserUrl?.(data.openBrowserUrl.trim());
            }
            const readReqId = data.readBrowserPage?.requestId?.trim();
            if (readReqId) {
              onReadBrowserPage?.(readReqId);
            }
            const headlessReqId = data.headlessPageText?.requestId?.trim();
            const headlessUrl = data.headlessPageText?.url?.trim();
            if (headlessReqId && headlessUrl) {
              onHeadlessPageText?.(headlessReqId, headlessUrl);
            }
            if (data.done === true) {
              final = {
                content: data.content ?? final.content,
                sessionId: data.sessionId ?? final.sessionId,
                error: data.error,
                lastRunId: data.lastRunId,
                cells: data.cells,
                userCells: data.userCells,
                contextCompressed: data.contextCompressed,
                sidebarUpdated: data.sidebarUpdated,
                insightOffer: data.insightOffer ?? null,
              };
            }
          } catch {
            // skip malformed line
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return final;
}

function chatHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", ...getAuthHeaders(), "X-User-Id": "default" };
  if (apiKey) {
    h["X-API-Key"] = apiKey;
    if (!h["Authorization"]) h["Authorization"] = `Bearer ${apiKey}`;
  }
  return h;
}

/** Chat list from the server (DB). q — content search; projectId — only chats in that project (without projectId returns all chats with project_id). */
export async function fetchChatList(q?: string, projectId?: string | null): Promise<ChatListItemApi[]> {
  const params = new URLSearchParams();
  if (q?.trim()) params.set("q", q.trim());
  if (projectId != null && projectId !== "") params.set("project_id", projectId);
  const url = params.toString() ? `${apiBase}/chat/list?${params}` : `${apiBase}/chat/list`;
  const res = await fetch(url, { method: "GET", headers: chatHeaders() });
  const data = (await res.json().catch(() => ({}))) as { chats?: ChatListItemApi[]; error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return Array.isArray(data.chats) ? data.chats : [];
}

/** History of one chat from the server (DB). */
export async function fetchChatHistory(sessionId: string): Promise<HistoryMessageApi[]> {
  const url = `${apiBase}/chat/history?session_id=${encodeURIComponent(sessionId)}`;
  const res = await fetch(url, { method: "GET", headers: chatHeaders() });
  const data = (await res.json().catch(() => ({}))) as { messages?: HistoryMessageApi[]; error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return Array.isArray(data.messages) ? data.messages : [];
}

/** One content-search hit (a message from a chat). */
export interface SearchResultItemApi {
  chatId: string;
  chatTitle: string;
  updated_at: number;
  role: "user" | "assistant";
  content: string;
  messageId: number;
}

/** Search messages by substring — returns messages from all of the user's chats. */
export async function fetchSearchResults(q: string): Promise<SearchResultItemApi[]> {
  const query = q.trim();
  if (!query) return [];
  const url = `${apiBase}/chat/search?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { method: "GET", headers: chatHeaders() });
  const data = (await res.json().catch(() => ({}))) as { results?: SearchResultItemApi[]; error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return Array.isArray(data.results) ? data.results : [];
}

/** Delete a chat on the server. */
export async function deleteChat(sessionId: string): Promise<boolean> {
  const url = `${apiBase}/chat?session_id=${encodeURIComponent(sessionId)}`;
  const res = await fetch(url, { method: "DELETE", headers: chatHeaders() });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.ok === true;
}

/** Attach a chat to a project or detach it (projectId === null). */
export async function updateChatProject(sessionId: string, projectId: string | null): Promise<boolean> {
  const url = apiBase + "/chat";
  const res = await fetch(url, {
    method: "PATCH",
    headers: chatHeaders(),
    body: JSON.stringify({ session_id: sessionId, project_id: projectId }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.ok === true;
}

/** Persist sidebar title (e.g. browser page title). */
export async function updateChatTitle(sessionId: string, title: string): Promise<boolean> {
  const t = title.trim();
  if (!sessionId || !t) return false;
  const url = apiBase + "/chat";
  const res = await fetch(url, {
    method: "PATCH",
    headers: chatHeaders(),
    body: JSON.stringify({ session_id: sessionId, title: t }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.ok === true;
}

/** Persist browser pageKey binding for a chat (survives restart). */
export async function updateChatBrowserPageKey(sessionId: string, pageKey: string): Promise<boolean> {
  const key = pageKey.trim();
  if (!sessionId || !key) return false;
  const url = apiBase + "/chat";
  const res = await fetch(url, {
    method: "PATCH",
    headers: chatHeaders(),
    body: JSON.stringify({ session_id: sessionId, browser_page_key: key }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.ok === true;
}

/** Per-chat LLM model; pass null to clear override (use settings default). */
export async function updateChatModel(
  sessionId: string,
  model: string | null
): Promise<string | null> {
  const id = sessionId.trim();
  if (!id) return null;
  const wanted = model != null && model.trim() ? model.trim() : null;
  const url = apiBase + "/chat";
  const res = await fetch(url, {
    method: "PATCH",
    headers: chatHeaders(),
    body: JSON.stringify({
      session_id: id,
      model: wanted,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    model?: string | null;
    error?: string;
  };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  if (data.ok === false) throw new Error(data.error || "Failed to save chat model");
  const m = typeof data.model === "string" && data.model.trim() ? data.model.trim() : null;
  // Prefer server value; if older gateway omitted it, keep the requested override.
  return m ?? wanted;
}

/** Pin / unpin chat in the sidebar. */
export async function updateChatPinned(sessionId: string, pinned: boolean): Promise<boolean> {
  const id = sessionId.trim();
  if (!id) return false;
  const url = apiBase + "/chat";
  const res = await fetch(url, {
    method: "PATCH",
    headers: chatHeaders(),
    body: JSON.stringify({ session_id: id, pinned: !!pinned }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.ok === true;
}

/** Favorite / unfavorite chat (star). */
export async function updateChatFavorited(sessionId: string, favorited: boolean): Promise<boolean> {
  const id = sessionId.trim();
  if (!id) return false;
  const url = apiBase + "/chat";
  const res = await fetch(url, {
    method: "PATCH",
    headers: chatHeaders(),
    body: JSON.stringify({ session_id: id, favorited: !!favorited }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.ok === true;
}

/** Bump chat updated_at so it rises to the top of the sidebar. */
export async function touchChat(sessionId: string): Promise<boolean> {
  const id = sessionId.trim();
  if (!id) return false;
  const url = apiBase + "/chat";
  const res = await fetch(url, {
    method: "PATCH",
    headers: chatHeaders(),
    body: JSON.stringify({ session_id: id, touch: true }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.ok === true;
}

export interface ClawCacheExportOptions {
  sessionId: string;
  name?: string;
  cacheId?: string;
  save?: boolean;
}

/** Export the session to .claw-cache (download or save into cacheStorePath on the server). */
export async function exportChatClawCache(opts: ClawCacheExportOptions): Promise<{ saved?: boolean; path?: string }> {
  const url = `${apiBase}/api/chat/export-claw-cache`;
  const res = await fetch(url, {
    method: "POST",
    headers: chatHeaders(),
    body: JSON.stringify({
      sessionId: opts.sessionId,
      name: opts.name,
      cache_id: opts.cacheId,
      save: opts.save === true,
    }),
  });
  const contentType = res.headers.get("Content-Type") ?? "";
  if (!res.ok) {
    const data = contentType.includes("json")
      ? ((await res.json().catch(() => ({}))) as { error?: string })
      : {};
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  if (contentType.includes("application/json")) {
    const data = (await res.json()) as { ok?: boolean; path?: string };
    return { saved: true, path: data.path };
  }
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const filenameMatch = disposition.match(/filename="([^"]+)"/);
  const filename = filenameMatch?.[1] ?? `${opts.cacheId ?? opts.sessionId}.claw-cache`;
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(objectUrl);
  return {};
}

/** Read a file as base64 for sending in chat */
export function readFileAsBase64(file: File): Promise<DocumentToSend> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] ?? "" : "";
      resolve({
        name: file.name,
        contentBase64: base64,
        mimeType: file.type || undefined,
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export interface GalleryImageItem {
  url: string;
  name: string;
  path: string;
}

export interface ChatDocumentItem {
  url: string;
  name: string;
  path: string;
  ext: string;
}

export interface ChatAssetsSummary {
  imageCount: number;
  documentCount: number;
}

/** Images from messages in the current chat. */
export async function fetchChatGallery(sessionId: string): Promise<GalleryImageItem[]> {
  const url = `${apiBase}/chat/gallery?session_id=${encodeURIComponent(sessionId)}`;
  const res = await fetch(url, { method: "GET", headers: chatHeaders() });
  const data = (await res.json().catch(() => ({}))) as { images?: GalleryImageItem[]; error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return Array.isArray(data.images) ? data.images : [];
}

/** Documents for the current chat (docx/pdf/… from history and session-prefixed output). */
export async function fetchChatDocuments(sessionId: string): Promise<ChatDocumentItem[]> {
  const url = `${apiBase}/chat/documents?session_id=${encodeURIComponent(sessionId)}`;
  const res = await fetch(url, { method: "GET", headers: chatHeaders() });
  const data = (await res.json().catch(() => ({}))) as { documents?: ChatDocumentItem[]; error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return Array.isArray(data.documents) ? data.documents : [];
}

/** Counters for sidebar items (gallery / documents). */
export async function fetchChatAssetsSummary(sessionId: string): Promise<ChatAssetsSummary> {
  const url = `${apiBase}/chat/assets-summary?session_id=${encodeURIComponent(sessionId)}`;
  const res = await fetch(url, { method: "GET", headers: chatHeaders() });
  const data = (await res.json().catch(() => ({}))) as ChatAssetsSummary & { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return {
    imageCount: typeof data.imageCount === "number" ? data.imageCount : 0,
    documentCount: typeof data.documentCount === "number" ? data.documentCount : 0,
  };
}

/** File URL that forces download. */
export function fileDownloadUrl(pathOrUrl: string): string {
  const path = pathOrUrl.startsWith("/files/")
    ? pathOrUrl.slice("/files/".length)
    : pathOrUrl.replace(/^\/+/, "");
  return `${apiBase.replace(/\/$/, "")}/files/${path}?download=1`;
}

/** Download a file (blob + a.download — more reliable than inline Content-Disposition). */
export async function downloadChatFile(pathOrUrl: string, filename: string): Promise<void> {
  const res = await fetch(fileDownloadUrl(pathOrUrl), { headers: getAuthHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(objectUrl);
}

/** Delete an image/document from disk (for images — tombstone in history). */
export async function deleteChatImage(pathOrUrl: string, sessionId?: string): Promise<void> {
  const path = pathOrUrl.startsWith("/files/")
    ? pathOrUrl.slice("/files/".length)
    : pathOrUrl.replace(/^\/+/, "");
  const q = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : "";
  const res = await fetch(`${apiBase.replace(/\/$/, "")}/files/${path}${q}`, {
    method: "DELETE",
    headers: chatHeaders(),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
}

export const deleteChatDocument = deleteChatImage;

export async function acceptInsightOffer(body: {
  chatId: string;
  pastChatId?: string;
  reasonCode: string;
  insightTopic: string;
  score?: number;
  excerpts?: string[];
  currentBrief?: string;
  pastChatTitle?: string;
  dateLabel?: string;
}): Promise<{ ok: boolean; text?: string }> {
  const res = await fetch(`${apiBase}/chat/insight/accept`, {
    method: "POST",
    headers: chatHeaders(),
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; text?: string; error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return { ok: !!data.ok, text: data.text };
}

export async function dismissInsightOffer(body: {
  chatId: string;
  pastChatId?: string;
  reasonCode: string;
  insightTopic: string;
  score?: number;
}): Promise<void> {
  const res = await fetch(`${apiBase}/chat/insight/dismiss`, {
    method: "POST",
    headers: chatHeaders(),
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
}

export async function fetchIdleInsightOffer(params: {
  sessionId: string;
  pageTitle?: string;
  pageKey?: string;
}): Promise<InsightOfferApi | null> {
  const q = new URLSearchParams({ session_id: params.sessionId });
  if (params.pageTitle?.trim()) q.set("page_title", params.pageTitle.trim());
  if (params.pageKey?.trim()) q.set("page_key", params.pageKey.trim());
  const res = await fetch(`${apiBase}/chat/insight/idle?${q}`, { method: "GET", headers: chatHeaders() });
  const data = (await res.json().catch(() => ({}))) as {
    insightOffer?: InsightOfferApi | null;
    error?: string;
  };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.insightOffer ?? null;
}

