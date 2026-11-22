// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { textHasDocumentRef } from "../chat-documents.js";

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  meta?: string;
}

type MessagePayload = Omit<SessionMessage, "role">;
type TurnPromptContext = { summary: string; coveredCount: number };

/** Server-side title bound: the UI caps input length, the API must too
 * (a multi-megabyte title used to be stored verbatim and re-rendered). */
const CHAT_TITLE_MAX_CHARS = 300;
const capTitle = (title: string | null | undefined): string =>
  (title ?? "").trim().slice(0, CHAT_TITLE_MAX_CHARS);

export interface ChatListItem {
  id: string;
  title: string;
  updated_at: number;
  project_id?: string | null;
  /** Normalized page URL for embedded-browser chats (survives restart). */
  browser_page_key?: string | null;
  /** Per-chat LLM model override; null/absent = settings default. */
  model?: string | null;
  /** Pinned to top of sidebar. */
  pinned?: boolean;
  /** Favorited (star). */
  favorited?: boolean;
  /** Fork lineage: id of the chat this one was duplicated/branched from; null = original. */
  forked_from_chat_id?: string | null;
  /** 1 = the title was set manually (rename); automatic titling must not overwrite it. */
  titleManual?: boolean;
  /** The chat has image attachments (sidebar indicator). */
  hasImages?: boolean;
  /** The chat has document attachments (sidebar indicator). */
  hasDocs?: boolean;
}

export interface ProjectListItem {
  id: string;
  name: string;
  /** Purpose/description of the project (logical link of chats).*/
  description: string;
  created_at: number;
  updated_at: number;
}

/** A short summary of the project's neighboring chat for system prompt.*/
export interface ProjectSiblingChatSummary {
  id: string;
  title: string;
  /** prompt_summary or the short tail of the last message*/
  digest: string;
}

export interface ProjectLlmContext {
  id: string;
  name: string;
  description: string;
  /** Other chats of the project (without the current one), newest first*/
  siblings: ProjectSiblingChatSummary[];
}

/** Chat access layer (portable interface: SQLite now, PostgreSQL later).*/
export interface ChatRepository {
  /** Create a user if absent.*/
  ensureUser(userId: string): void;
  /** Create or update a chat; return the current updated_at. projectId — binding to the project (optional).*/
  ensureChat(
    sessionId: string,
    userId: string,
    title?: string,
    projectId?: string | null,
    browserPageKey?: string | null
  ): number;
  /** Overwrite chat title (browser page title). */
  updateChatTitle(chatId: string, userId: string, title: string): boolean;
  /** Rename the chat from the UI: sets the title and marks it manual (auto-titling must not overwrite it). */
  renameChatTitle(chatId: string, userId: string, title: string): boolean;
  /** True when the chat title was set manually. */
  isTitleManual(chatId: string, userId: string): boolean;
  /** Per-chat attachment indicators from stored messages (image cells, /files/ document references). */
  attachmentRefsByChat(userId: string): Map<string, { images: boolean; docs: boolean }>;
  /** Bind chat to a normalized browser page URL. */
  updateChatBrowserPageKey(chatId: string, userId: string, pageKey: string | null): boolean;
  /** Per-chat LLM model; null clears override (use settings default). */
  updateChatModel(chatId: string, userId: string, model: string | null): boolean;
  /** Read per-chat model override (null = default). */
  getChatModel(chatId: string, userId: string): string | null;
  /** Pin / unpin chat (does not bump updated_at). */
  updateChatPinned(chatId: string, userId: string, pinned: boolean): boolean;
  /** Favorite / unfavorite chat (does not bump updated_at). */
  updateChatFavorited(chatId: string, userId: string, favorited: boolean): boolean;
  /** Add a message to both history stores and update the owned chat's timestamp. */
  appendMessage(chatId: string, userId: string, role: "user" | "assistant", content: string, meta?: string): void;
  /** Atomically append the user/assistant pair to both history stores, along with any new prompt recap. */
  appendTurn(
    chatId: string,
    userId: string,
    user: MessagePayload,
    assistant: MessagePayload,
    promptContext?: TurnPromptContext
  ): void;
  /** Chat message history (full UI feed). Checking user_id.*/
  getMessages(chatId: string, userId: string): SessionMessage[];
  /** Replace chat history (scrub, etc.; not for summarize).*/
  replaceMessages(chatId: string, userId: string, messages: SessionMessage[]): void;
  /** Resume cache for assembling the LLM prompt (not displayed in the UI ribbon).*/
  getPromptContext(chatId: string, userId: string): { summary: string; coveredCount: number } | null;
  setPromptContext(chatId: string, userId: string, summary: string, coveredCount: number): void;
  clearPromptContext(chatId: string, userId: string): void;
  /** List of user chats by updated_at DESC. If projectId is specified, only chats of this project.*/
  listChats(userId: string, projectId?: string | null): ChatListItem[];
  /** project_id of the chat by sessionId (or null).*/
  getChatProjectId(chatId: string, userId: string): string | null;
  /** List of user projects by updated_at DESC.*/
  listProjects(userId: string): ProjectListItem[];
  /** Get the project by id (if it belongs to the user).*/
  getProject(userId: string, projectId: string): ProjectListItem | null;
  /** Create a project. Returns the created project.*/
  createProject(userId: string, name: string, description?: string): ProjectListItem;
  /** Update the project name and/or description.*/
  updateProject(
    userId: string,
    projectId: string,
    patch: { name?: string; description?: string }
  ): ProjectListItem | null;
  /** Project context for LLM: goal + digests of neighboring chats.*/
  getProjectLlmContext(
    userId: string,
    projectId: string,
    currentChatId: string
  ): ProjectLlmContext | null;
  /** Delete project. Returns true only if the project is owned by user and there are no chats in it.*/
  deleteProject(userId: string, projectId: string): boolean;
  /** Search for chats by message content (substring in content).*/
  searchChats(userId: string, query: string): ChatListItem[];
  /** Search messages by substring: all messages from user chats, where content contains query.*/
  searchMessages(userId: string, query: string): SearchResultItem[];
  /** Search by append-only transcript of the current chat (substring, without semantics).*/
  searchTranscript(chatId: string, userId: string, query: string, limit?: number): TranscriptSearchHitRow[];
  /** Table of contents of the transcript: id, role, preview (pagination by afterId).*/
  listTranscript(
    chatId: string,
    userId: string,
    options?: TranscriptListOptionsRow
  ): TranscriptListResultRow;
  /** Read a fragment of the transcript: the range fromId–toId or the window around the anchor.*/
  readTranscript(
    chatId: string,
    userId: string,
    options: TranscriptReadOptionsRow
  ): TranscriptReadResultRow;
  /** History of one chat (for GET /chat/history). If the chat does not belong to the user - an empty array.*/
  getChatHistory(chatId: string, userId: string): SessionMessage[];
  /**
   * Fork a chat: create a copy of its row and message history (full, or only the
   * first upToCount messages when given) under the newChatId. Metadata (project,
   * model, browser_page_key) is carried over and pinned/favorited are reset. The
   * recap is carried over only if all its covered messages are copied. Returns
   * the new chat id, or null if the source chat does not belong to the user.
   */
  duplicateChat(
    userId: string,
    sourceChatId: string,
    newChatId: string,
    opts?: { title?: string | null; upToCount?: number }
  ): string | null;
  /** forked_from_chat_id of the chat (or null). Used to walk the fork chain upward.*/
  getForkParent(chatId: string, userId: string): string | null;
  /** True only when the chat exists AND belongs to the user (hosted-mode file scoping).*/
  chatExists(chatId: string, userId: string): boolean;
  /** Delete the chat and all its messages. Children forks are re-attached to the deleted chat's parent (graft). Returns true if the chat belonged to the user and was deleted.*/
  deleteChat(chatId: string, userId: string): boolean;
  /** Link the chat to a project or unlink it (projectId === null). Returns true if the chat is found and belongs to user.*/
  updateChatProject(chatId: string, userId: string, projectId: string | null): boolean;
  /** Bump updated_at so the chat rises to the top of the sidebar list. */
  touchChatUpdatedAt(chatId: string, userId: string): boolean;
  /** Last K messages with created_at (for unresolved-thread heuristics).*/
  getChatMessageTail(chatId: string, userId: string, limit: number): ChatMessageTailItem[];
  /** Recent chats for unresolved scan (excludes current).*/
  listRecentChatsForInsights(userId: string, excludeChatId: string, limit: number): ChatListItem[];
  recordInsightEvent(event: InsightEventInput): string;
  hasInsightEvent(
    userId: string,
    pastChatId: string | null | undefined,
    reasonCode: string,
    insightTopic: string
  ): boolean;
  /** Latest offered/accepted/dismissed for cooldown on this chat.*/
  lastInsightEventAt(chatId: string, userId: string): number | null;
}

export interface ChatMessageTailItem {
  role: "user" | "assistant";
  content: string;
  created_at: number;
}

export interface InsightEventInput {
  id?: string;
  userId: string;
  chatId: string;
  pastChatId?: string | null;
  status: "accepted" | "dismissed" | "offered";
  insightTopic: string;
  reasonCode: string;
  score?: number | null;
}

export interface SearchResultItem {
  chatId: string;
  chatTitle: string;
  updated_at: number;
  role: "user" | "assistant";
  content: string;
  messageId: number;
}

export interface TranscriptSearchHitRow {
  messageId: number;
  role: "user" | "assistant";
  excerpt: string;
  createdAt: number;
  matchIndex?: number;
}

export interface TranscriptMessageRow {
  messageId: number;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

export interface TranscriptReadResultRow {
  messages: TranscriptMessageRow[];
  truncated?: boolean;
  anchorMessageId?: number;
  fromId?: number;
  toId?: number;
}

export interface TranscriptListItemRow {
  messageId: number;
  role: "user" | "assistant";
  preview: string;
  createdAt: number;
}

export interface TranscriptListResultRow {
  items: TranscriptListItemRow[];
  totalCount: number;
  nextAfterId?: number;
}

export interface TranscriptListOptionsRow {
  afterId?: number;
  limit?: number;
}

export interface TranscriptReadOptionsRow {
  messageId?: number;
  query?: string;
  before?: number;
  after?: number;
  fromId?: number;
  toId?: number;
  limit?: number;
}

function mapChatListRow(r: {
  id: string;
  title: string;
  updated_at: number;
  project_id?: string | null;
  browser_page_key?: string | null;
  model?: string | null;
  pinned?: number | null;
  favorited?: number | null;
  forked_from_chat_id?: string | null;
  title_manual?: number | null;
  hasImages?: boolean;
  hasDocs?: boolean;
}): ChatListItem {
  return {
    id: r.id,
    title: r.title,
    updated_at: r.updated_at,
    project_id: r.project_id ?? null,
    browser_page_key: r.browser_page_key ?? null,
    model: typeof r.model === "string" && r.model.trim() ? r.model.trim() : null,
    pinned: Number(r.pinned ?? 0) === 1,
    favorited: Number(r.favorited ?? 0) === 1,
    forked_from_chat_id: r.forked_from_chat_id ?? null,
    titleManual: Number(r.title_manual ?? 0) === 1,
    ...(r.hasImages ? { hasImages: true } : {}),
    ...(r.hasDocs ? { hasDocs: true } : {}),
  };
}

export class SqliteChatRepository implements ChatRepository {
  constructor(private db: import("better-sqlite3").Database) {}

  ensureUser(userId: string): void {
    const now = Date.now();
    this.db
      .prepare("INSERT INTO users (id, created_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING")
      .run(userId, now);
  }

  ensureChat(
    sessionId: string,
    userId: string,
    title?: string,
    projectId?: string | null,
    browserPageKey?: string | null
  ): number {
    this.ensureUser(userId);
    const now = Date.now();
    const existing = this.db
      .prepare("SELECT title, updated_at, browser_page_key FROM chats WHERE id = ? AND user_id = ?")
      .get(sessionId, userId) as
        | { title: string; updated_at: number; browser_page_key?: string | null }
        | undefined;
    if (existing) {
      // The title is fixed during creation; We don’t overwrite it later with someone else’s message.
      const keepTitle = (existing.title ?? "").trim();
      const nextTitle = keepTitle || capTitle(title) || keepTitle;
      const nextPageKey =
        browserPageKey !== undefined
          ? browserPageKey
          : existing.browser_page_key ?? null;
      if (projectId !== undefined) {
        this.db
          .prepare(
            "UPDATE chats SET title = ?, updated_at = ?, project_id = ?, browser_page_key = ? WHERE id = ? AND user_id = ?"
          )
          .run(nextTitle, now, projectId, nextPageKey, sessionId, userId);
      } else {
        this.db
          .prepare(
            "UPDATE chats SET title = ?, updated_at = ?, browser_page_key = ? WHERE id = ? AND user_id = ?"
          )
          .run(nextTitle, now, nextPageKey, sessionId, userId);
      }
      return now;
    }
    this.db
      .prepare(
        "INSERT INTO chats (id, user_id, project_id, title, browser_page_key, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(sessionId, userId, projectId ?? null, capTitle(title), browserPageKey ?? null, now, now);
    return now;
  }

  updateChatTitle(chatId: string, userId: string, title: string): boolean {
    const next = capTitle(title);
    if (!next) return false;
    const now = Date.now();
    const r = this.db
      .prepare("UPDATE chats SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(next, now, chatId, userId);
    return r.changes > 0;
  }

  renameChatTitle(chatId: string, userId: string, title: string): boolean {
    const next = capTitle(title);
    if (!next) return false;
    const r = this.db
      .prepare(
        "UPDATE chats SET title = ?, title_manual = 1, updated_at = ? WHERE id = ? AND user_id = ?"
      )
      .run(next, Date.now(), chatId, userId);
    return r.changes > 0;
  }

  isTitleManual(chatId: string, userId: string): boolean {
    const row = this.db
      .prepare("SELECT title_manual FROM chats WHERE id = ? AND user_id = ?")
      .get(chatId, userId) as { title_manual?: number | null } | undefined;
    return Number(row?.title_manual ?? 0) === 1;
  }

  attachmentRefsByChat(userId: string): Map<string, { images: boolean; docs: boolean }> {
    const rows = this.db
      .prepare(
        `SELECT m.chat_id AS chatId, m.content AS content, m.meta AS meta
         FROM messages m JOIN chats c ON c.id = m.chat_id AND c.user_id = ?
         WHERE m.content LIKE '%/files/%' OR m.meta LIKE '%/files/%' OR m.meta LIKE '%"type":"image"%'`
      )
      .all(userId) as Array<{ chatId: string; content: string | null; meta: string | null }>;
    const flags = new Map<string, { images: boolean; docs: boolean }>();
    const mark = (id: string, images?: boolean, docs?: boolean) => {
      const cur = flags.get(id) ?? { images: false, docs: false };
      flags.set(id, { images: cur.images || !!images, docs: cur.docs || !!docs });
    };
    for (const r of rows) {
      if (r.meta?.includes('"type":"image"')) mark(r.chatId, true);
      const text = `${r.content ?? ""}
${r.meta ?? ""}`;
      if (textHasDocumentRef(text)) mark(r.chatId, undefined, true);
    }
    return flags;
  }

  updateChatBrowserPageKey(chatId: string, userId: string, pageKey: string | null): boolean {
    const now = Date.now();
    const key = pageKey != null && pageKey.trim() ? pageKey.trim() : null;
    const r = this.db
      .prepare("UPDATE chats SET browser_page_key = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(key, now, chatId, userId);
    return r.changes > 0;
  }

  updateChatModel(chatId: string, userId: string, model: string | null): boolean {
    this.ensureUser(userId);
    const exists = this.db.prepare("SELECT 1 FROM chats WHERE id = ? AND user_id = ?").get(chatId, userId);
    if (!exists) {
      this.ensureChat(chatId, userId);
    }
    const now = Date.now();
    const next = model != null && model.trim() ? model.trim() : null;
    const r = this.db
      .prepare("UPDATE chats SET model = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(next, now, chatId, userId);
    if (r.changes > 0) return true;
    // Already at desired value (SQLite may report 0 changes) — still success.
    return this.getChatModel(chatId, userId) === next;
  }

  getChatModel(chatId: string, userId: string): string | null {
    const row = this.db
      .prepare("SELECT model FROM chats WHERE id = ? AND user_id = ?")
      .get(chatId, userId) as { model?: string | null } | undefined;
    const m = typeof row?.model === "string" ? row.model.trim() : "";
    return m || null;
  }

  updateChatPinned(chatId: string, userId: string, pinned: boolean): boolean {
    this.ensureUser(userId);
    const exists = this.db.prepare("SELECT 1 FROM chats WHERE id = ? AND user_id = ?").get(chatId, userId);
    if (!exists) {
      this.ensureChat(chatId, userId);
    }
    const next = pinned ? 1 : 0;
    const r = this.db
      .prepare("UPDATE chats SET pinned = ? WHERE id = ? AND user_id = ?")
      .run(next, chatId, userId);
    if (r.changes > 0) return true;
    const row = this.db
      .prepare("SELECT pinned FROM chats WHERE id = ? AND user_id = ?")
      .get(chatId, userId) as { pinned?: number } | undefined;
    return Number(row?.pinned ?? 0) === next;
  }

  updateChatFavorited(chatId: string, userId: string, favorited: boolean): boolean {
    this.ensureUser(userId);
    const exists = this.db.prepare("SELECT 1 FROM chats WHERE id = ? AND user_id = ?").get(chatId, userId);
    if (!exists) {
      this.ensureChat(chatId, userId);
    }
    const next = favorited ? 1 : 0;
    const r = this.db
      .prepare("UPDATE chats SET favorited = ? WHERE id = ? AND user_id = ?")
      .run(next, chatId, userId);
    if (r.changes > 0) return true;
    const row = this.db
      .prepare("SELECT favorited FROM chats WHERE id = ? AND user_id = ?")
      .get(chatId, userId) as { favorited?: number } | undefined;
    return Number(row?.favorited ?? 0) === next;
  }

  appendMessage(chatId: string, userId: string, role: "user" | "assistant", content: string, meta?: string): void {
    this.appendMessages(chatId, userId, [{ role, content, meta }]);
  }

  appendTurn(
    chatId: string,
    userId: string,
    user: MessagePayload,
    assistant: MessagePayload,
    promptContext?: TurnPromptContext
  ): void {
    this.appendMessages(chatId, userId, [
      { ...user, role: "user" },
      { ...assistant, role: "assistant" },
    ], promptContext);
  }

  private appendMessages(
    chatId: string,
    userId: string,
    messages: SessionMessage[],
    promptContext?: TurnPromptContext
  ): void {
    this.db.transaction(() => {
      const now = Date.now();
      const updated = this.db
        .prepare("UPDATE chats SET updated_at = ? WHERE id = ? AND user_id = ?")
        .run(now, chatId, userId);
      if (updated.changes !== 1) throw new Error("Chat not found");

      const insertMessage = this.db.prepare(
        "INSERT INTO messages (chat_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)"
      );
      const insertTranscript = this.db.prepare(
        "INSERT INTO transcript_messages (chat_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)"
      );
      for (const { role, content, meta } of messages) {
        insertMessage.run(chatId, role, content, meta ?? null, now);
        insertTranscript.run(chatId, role, content, meta ?? null, now);
      }
      if (promptContext) {
        this.setPromptContext(chatId, userId, promptContext.summary, promptContext.coveredCount);
      }
    })();
  }

  getMessages(chatId: string, userId: string): SessionMessage[] {
    const ok = this.db.prepare("SELECT 1 FROM chats WHERE id = ? AND user_id = ?").get(chatId, userId);
    if (!ok) return [];
    const rows = this.db
      .prepare("SELECT role, content, meta FROM messages WHERE chat_id = ? ORDER BY id")
      .all(chatId) as Array<{ role: string; content: string; meta: string | null }>;
    return rows.map((r) => ({ role: r.role as "user" | "assistant", content: r.content, ...(r.meta ? { meta: r.meta } : {}) }));
  }

  replaceMessages(chatId: string, userId: string, messages: SessionMessage[]): void {
    const ok = this.db.prepare("SELECT 1 FROM chats WHERE id = ? AND user_id = ?").get(chatId, userId);
    if (!ok) return;
    const now = Date.now();
    this.db.prepare("UPDATE chats SET updated_at = ? WHERE id = ? AND user_id = ?").run(now, chatId, userId);
    this.db.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId);
    const ins = this.db.prepare("INSERT INTO messages (chat_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)");
    for (const m of messages) {
      ins.run(chatId, m.role, m.content, m.meta ?? null, now);
    }
  }

  getPromptContext(chatId: string, userId: string): { summary: string; coveredCount: number } | null {
    const row = this.db
      .prepare(
        "SELECT prompt_summary AS summary, prompt_covered_count AS coveredCount FROM chats WHERE id = ? AND user_id = ?"
      )
      .get(chatId, userId) as { summary: string | null; coveredCount: number | null } | undefined;
    if (!row) return null;
    const summary = typeof row.summary === "string" ? row.summary.trim() : "";
    const coveredCount = typeof row.coveredCount === "number" ? row.coveredCount : 0;
    if (!summary || coveredCount <= 0) return null;
    return { summary, coveredCount };
  }

  setPromptContext(chatId: string, userId: string, summary: string, coveredCount: number): void {
    const ok = this.db.prepare("SELECT 1 FROM chats WHERE id = ? AND user_id = ?").get(chatId, userId);
    if (!ok) return;
    const text = summary.trim();
    if (!text || coveredCount <= 0) {
      this.clearPromptContext(chatId, userId);
      return;
    }
    this.db
      .prepare(
        "UPDATE chats SET prompt_summary = ?, prompt_covered_count = ?, updated_at = ? WHERE id = ? AND user_id = ?"
      )
      .run(text, coveredCount, Date.now(), chatId, userId);
  }

  clearPromptContext(chatId: string, userId: string): void {
    const ok = this.db.prepare("SELECT 1 FROM chats WHERE id = ? AND user_id = ?").get(chatId, userId);
    if (!ok) return;
    this.db
      .prepare(
        "UPDATE chats SET prompt_summary = NULL, prompt_covered_count = 0, updated_at = ? WHERE id = ? AND user_id = ?"
      )
      .run(Date.now(), chatId, userId);
  }

  listChats(userId: string, projectId?: string | null): ChatListItem[] {
    const hasProject = projectId !== undefined && projectId !== null && projectId !== "";
    const stmt = hasProject
      ? this.db.prepare(
          "SELECT id, title, updated_at, project_id, browser_page_key, model, pinned, favorited, forked_from_chat_id, title_manual FROM chats WHERE user_id = ? AND project_id = ? ORDER BY pinned DESC, favorited DESC, updated_at DESC"
        )
      : this.db.prepare(
          "SELECT id, title, updated_at, project_id, browser_page_key, model, pinned, favorited, forked_from_chat_id, title_manual FROM chats WHERE user_id = ? ORDER BY pinned DESC, favorited DESC, updated_at DESC"
        );
    const rows = (hasProject ? stmt.all(userId, projectId) : stmt.all(userId)) as Array<{
      id: string;
      title: string;
      updated_at: number;
      project_id?: string | null;
      browser_page_key?: string | null;
      model?: string | null;
      pinned?: number | null;
      favorited?: number | null;
      forked_from_chat_id?: string | null;
      title_manual?: number | null;
    }>;
    return rows.map((r) => mapChatListRow(r));
  }

  getChatProjectId(chatId: string, userId: string): string | null {
    const row = this.db.prepare("SELECT project_id FROM chats WHERE id = ? AND user_id = ?").get(chatId, userId) as { project_id?: string | null } | undefined;
    const pid = row?.project_id;
    return pid != null && pid !== "" ? pid : null;
  }

  listProjects(userId: string): ProjectListItem[] {
    this.ensureUser(userId);
    const rows = this.db
      .prepare(
        "SELECT id, name, COALESCE(description, '') AS description, created_at, updated_at FROM projects WHERE user_id = ? ORDER BY updated_at DESC"
      )
      .all(userId) as Array<{
      id: string;
      name: string;
      description: string;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description ?? "",
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  }

  getProject(userId: string, projectId: string): ProjectListItem | null {
    const row = this.db
      .prepare(
        "SELECT id, name, COALESCE(description, '') AS description, created_at, updated_at FROM projects WHERE id = ? AND user_id = ?"
      )
      .get(projectId, userId) as
      | { id: string; name: string; description: string; created_at: number; updated_at: number }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? "",
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  createProject(userId: string, name: string, description = ""): ProjectListItem {
    this.ensureUser(userId);
    const id = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const now = Date.now();
    const nameVal = name.trim() || "Project";
    const descVal = description.trim().slice(0, 4000);
    this.db
      .prepare(
        "INSERT INTO projects (id, user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(id, userId, nameVal, descVal, now, now);
    return { id, name: nameVal, description: descVal, created_at: now, updated_at: now };
  }

  updateProject(
    userId: string,
    projectId: string,
    patch: { name?: string; description?: string }
  ): ProjectListItem | null {
    const current = this.getProject(userId, projectId);
    if (!current) return null;
    const nameVal =
      patch.name !== undefined ? patch.name.trim() || current.name : current.name;
    const descVal =
      patch.description !== undefined
        ? patch.description.trim().slice(0, 4000)
        : current.description;
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ? AND user_id = ?"
      )
      .run(nameVal, descVal, now, projectId, userId);
    return { id: projectId, name: nameVal, description: descVal, created_at: current.created_at, updated_at: now };
  }

  getProjectLlmContext(
    userId: string,
    projectId: string,
    currentChatId: string
  ): ProjectLlmContext | null {
    const project = this.getProject(userId, projectId);
    if (!project) return null;
    const chats = this.listChats(userId, projectId).filter((c) => c.id !== currentChatId);
    const siblings: ProjectSiblingChatSummary[] = [];
    const maxSiblings = 12;
    for (const chat of chats.slice(0, maxSiblings)) {
      const promptCtx = this.getPromptContext(chat.id, userId);
      let digest = (promptCtx?.summary ?? "").trim();
      if (!digest) {
        const last = this.db
          .prepare(
            "SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1"
          )
          .get(chat.id) as { role: string; content: string } | undefined;
        if (last?.content?.trim()) {
          const oneLine = last.content.replace(/\s+/g, " ").trim();
          digest = `${last.role === "user" ? "User" : "Assistant"}: ${oneLine.slice(0, 220)}${
            oneLine.length > 220 ? "…" : ""
          }`;
        }
      } else {
        digest = digest.replace(/\s+/g, " ").trim().slice(0, 280);
      }
      siblings.push({
        id: chat.id,
        title: (chat.title || "Chat").trim() || "Chat",
        digest,
      });
    }
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      siblings,
    };
  }

  deleteProject(userId: string, projectId: string): boolean {
    const project = this.getProject(userId, projectId);
    if (!project) return false;
    const chatInProject = this.db.prepare("SELECT 1 FROM chats WHERE project_id = ? LIMIT 1").get(projectId);
    if (chatInProject) return false;
    this.db.prepare("DELETE FROM projects WHERE id = ? AND user_id = ?").run(projectId, userId);
    return true;
  }

  searchChats(userId: string, query: string): ChatListItem[] {
    const q = query.trim();
    if (!q) return this.listChats(userId);
    const escaped = q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    const like = `%${escaped.toLowerCase()}%`;
    const rows = this.db
      .prepare(
        `SELECT DISTINCT c.id, c.title, c.updated_at, c.project_id, c.browser_page_key, c.model, c.pinned, c.favorited FROM chats c
         INNER JOIN messages m ON m.chat_id = c.id
         WHERE c.user_id = ? AND LOWER(m.content) LIKE ? ESCAPE '\\'
         ORDER BY c.pinned DESC, c.favorited DESC, c.updated_at DESC`
      )
      .all(userId, like) as Array<{
        id: string;
        title: string;
        updated_at: number;
        project_id?: string | null;
        browser_page_key?: string | null;
        model?: string | null;
        pinned?: number | null;
        favorited?: number | null;
      }>;
    return rows.map((r) => mapChatListRow(r));
  }

  searchMessages(userId: string, query: string): SearchResultItem[] {
    const q = query.trim();
    if (!q) return [];
    const escaped = q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    const like = `%${escaped.toLowerCase()}%`;
    const rows = this.db
      .prepare(
        `SELECT m.id AS messageId, m.chat_id AS chatId, m.role, m.content, c.title AS chatTitle, c.updated_at
         FROM messages m
         INNER JOIN chats c ON c.id = m.chat_id AND c.user_id = ?
         WHERE LOWER(m.content) LIKE ? ESCAPE '\\'
         ORDER BY c.updated_at DESC, m.id ASC`
      )
      .all(userId, like) as Array<{ messageId: number; chatId: string; role: string; content: string; chatTitle: string; updated_at: number }>;
    return rows.map((r) => ({
      chatId: r.chatId,
      chatTitle: r.chatTitle,
      updated_at: r.updated_at,
      role: r.role as "user" | "assistant",
      content: r.content,
      messageId: r.messageId,
    }));
  }

  searchTranscript(chatId: string, userId: string, query: string, limit = 5): TranscriptSearchHitRow[] {
    const ok = this.db.prepare("SELECT 1 FROM chats WHERE id = ? AND user_id = ?").get(chatId, userId);
    if (!ok) return [];
    const q = query.trim();
    if (!q) return [];
    const cap = Math.max(1, Math.min(limit, 8));
    const escaped = q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    const like = `%${escaped.toLowerCase()}%`;
    const rows = this.db
      .prepare(
        `SELECT id AS messageId, role, content, created_at AS createdAt
         FROM transcript_messages
         WHERE chat_id = ? AND LOWER(content) LIKE ? ESCAPE '\\'
         ORDER BY id ASC
         LIMIT ?`
      )
      .all(chatId, like, cap) as Array<{
      messageId: number;
      role: string;
      content: string;
      createdAt: number;
    }>;
    const excerptChars = 400;
    return rows.map((r) => {
      const lower = r.content.toLowerCase();
      const needle = q.toLowerCase();
      const idx = lower.indexOf(needle);
      let excerpt = r.content;
      let matchIndex: number | undefined;
      if (idx >= 0) {
        matchIndex = idx;
        const start = Math.max(0, idx - Math.floor(excerptChars / 4));
        excerpt = r.content.slice(start, start + excerptChars);
        if (start > 0) excerpt = `…${excerpt}`;
        if (start + excerptChars < r.content.length) excerpt = `${excerpt}…`;
      } else if (excerpt.length > excerptChars) {
        excerpt = `${excerpt.slice(0, excerptChars)}…`;
      }
      return {
        messageId: r.messageId,
        role: r.role as "user" | "assistant",
        excerpt,
        createdAt: r.createdAt,
        ...(matchIndex !== undefined ? { matchIndex } : {}),
      };
    });
  }

  listTranscript(
    chatId: string,
    userId: string,
    options: TranscriptListOptionsRow = {}
  ): TranscriptListResultRow {
    const ok = this.db.prepare("SELECT 1 FROM chats WHERE id = ? AND user_id = ?").get(chatId, userId);
    if (!ok) return { items: [], totalCount: 0 };

    const afterId = Math.max(0, Math.floor(options.afterId ?? 0));
    const limit = Math.max(1, Math.min(options.limit ?? 20, 50));
    const previewChars = 120;

    const countRow = this.db
      .prepare("SELECT COUNT(*) AS c FROM transcript_messages WHERE chat_id = ?")
      .get(chatId) as { c: number };
    const totalCount = countRow?.c ?? 0;

    const rows = this.db
      .prepare(
        `SELECT id AS messageId, role, content, created_at AS createdAt
         FROM transcript_messages
         WHERE chat_id = ? AND id > ?
         ORDER BY id ASC
         LIMIT ?`
      )
      .all(chatId, afterId, limit) as Array<{
      messageId: number;
      role: string;
      content: string;
      createdAt: number;
    }>;

    const items: TranscriptListItemRow[] = rows.map((r) => ({
      messageId: r.messageId,
      role: r.role as "user" | "assistant",
      preview: this.transcriptPreviewLine(r.content, previewChars),
      createdAt: r.createdAt,
    }));

    const lastId = items[items.length - 1]?.messageId;
    const nextAfterId =
      lastId != null && items.length === limit && lastId < (this.maxTranscriptId(chatId) ?? lastId)
        ? lastId
        : undefined;

    return { items, totalCount, ...(nextAfterId != null ? { nextAfterId } : {}) };
  }

  private maxTranscriptId(chatId: string): number | undefined {
    const row = this.db
      .prepare("SELECT MAX(id) AS maxId FROM transcript_messages WHERE chat_id = ?")
      .get(chatId) as { maxId: number | null } | undefined;
    return row?.maxId ?? undefined;
  }

  private transcriptPreviewLine(content: string, maxChars: number): string {
    const line = content.replace(/\s+/g, " ").trim();
    if (!line) return "(empty)";
    if (line.length <= maxChars) return line;
    return `${line.slice(0, Math.max(1, maxChars - 1))}…`;
  }

  readTranscript(
    chatId: string,
    userId: string,
    options: TranscriptReadOptionsRow
  ): TranscriptReadResultRow {
    const ok = this.db.prepare("SELECT 1 FROM chats WHERE id = ? AND user_id = ?").get(chatId, userId);
    if (!ok) return { messages: [] };

    const maxTotalChars = 12_000;

    if (options.fromId != null && Number.isFinite(options.fromId)) {
      const fromId = Math.max(1, Math.floor(options.fromId));
      const rangeLimit = Math.max(1, Math.min(options.limit ?? 5, 10));
      const toId =
        options.toId != null && Number.isFinite(options.toId)
          ? Math.max(fromId, Math.floor(options.toId))
          : fromId + rangeLimit - 1;

      const rows = this.db
        .prepare(
          `SELECT id AS messageId, role, content, created_at AS createdAt
           FROM transcript_messages
           WHERE chat_id = ? AND id >= ? AND id <= ?
           ORDER BY id ASC
           LIMIT ?`
        )
        .all(chatId, fromId, toId, rangeLimit) as Array<{
        messageId: number;
        role: string;
        content: string;
        createdAt: number;
      }>;

      const packed = this.packTranscriptMessages(rows, maxTotalChars);
      return {
        messages: packed.messages,
        fromId,
        toId: rows[rows.length - 1]?.messageId ?? toId,
        ...(packed.truncated ? { truncated: true } : {}),
      };
    }

    let anchorId = options.messageId;
    if (anchorId == null && options.query?.trim()) {
      const hits = this.searchTranscript(chatId, userId, options.query.trim(), 1);
      anchorId = hits[0]?.messageId;
    }
    if (anchorId == null || !Number.isFinite(anchorId)) {
      return { messages: [] };
    }

    const before = Math.max(0, Math.min(options.before ?? 0, 3));
    const after = Math.max(0, Math.min(options.after ?? 1, 3));
    const maxMessages = 5;

    const anchorRow = this.db
      .prepare("SELECT id FROM transcript_messages WHERE chat_id = ? AND id = ?")
      .get(chatId, anchorId) as { id: number } | undefined;
    if (!anchorRow) return { messages: [] };

    const startId = Math.max(1, anchorId - before);
    const endId = anchorId + after;
    const rows = this.db
      .prepare(
        `SELECT id AS messageId, role, content, created_at AS createdAt
         FROM transcript_messages
         WHERE chat_id = ? AND id >= ? AND id <= ?
         ORDER BY id ASC
         LIMIT ?`
      )
      .all(chatId, startId, endId, maxMessages) as Array<{
      messageId: number;
      role: string;
      content: string;
      createdAt: number;
    }>;

    const packed = this.packTranscriptMessages(rows, maxTotalChars);
    return {
      messages: packed.messages,
      anchorMessageId: anchorId,
      ...(packed.truncated ? { truncated: true } : {}),
    };
  }

  private packTranscriptMessages(
    rows: Array<{ messageId: number; role: string; content: string; createdAt: number }>,
    maxTotalChars: number
  ): { messages: TranscriptMessageRow[]; truncated: boolean } {
    const messages: TranscriptMessageRow[] = [];
    let total = 0;
    let truncated = false;
    for (const r of rows) {
      let content = r.content;
      if (total + content.length > maxTotalChars) {
        const room = maxTotalChars - total;
        if (room > 200) {
          content = `${content.slice(0, room)}... [cut off]`;
          messages.push({
            messageId: r.messageId,
            role: r.role as "user" | "assistant",
            content,
            createdAt: r.createdAt,
          });
        }
        truncated = true;
        break;
      }
      total += content.length;
      messages.push({
        messageId: r.messageId,
        role: r.role as "user" | "assistant",
        content,
        createdAt: r.createdAt,
      });
    }
    return { messages, truncated };
  }

  getChatHistory(chatId: string, userId: string): SessionMessage[] {
    return this.getMessages(chatId, userId);
  }

  duplicateChat(
    userId: string,
    sourceChatId: string,
    newChatId: string,
    opts?: { title?: string | null; upToCount?: number }
  ): string | null {
    const id = newChatId.trim();
    if (!id) return null;
    const upTo =
      typeof opts?.upToCount === "number" && Number.isFinite(opts.upToCount)
        ? Math.max(0, Math.floor(opts.upToCount))
        : null;
    const tx = this.db.transaction(() => {
      const src = this.db
        .prepare(
          "SELECT project_id, title, browser_page_key, model, prompt_summary, prompt_covered_count FROM chats WHERE id = ? AND user_id = ?"
        )
        .get(sourceChatId, userId) as
        | {
            title: string;
            project_id: string | null;
            browser_page_key: string | null;
            model: string | null;
            prompt_summary: string | null;
            prompt_covered_count: number;
          }
        | undefined;
      if (!src) return null;
      const title = capTitle(opts?.title) || src.title.slice(0, CHAT_TITLE_MAX_CHARS);
      const now = Date.now();
      this.db
        .prepare(
          "INSERT INTO chats (id, user_id, project_id, title, browser_page_key, model, pinned, favorited, updated_at, created_at, forked_from_chat_id) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)"
        )
        .run(id, userId, src.project_id, title, src.browser_page_key, src.model, now, now, sourceChatId);
      // Copy the message history with original meta/created_at (media cells and
      // /files/... references keep working); the fork shares files, links suffice.
      const copyInto = (table: "messages" | "transcript_messages"): number => {
        if (upTo === 0) return 0;
        const limit = upTo == null ? [] : [upTo];
        return this.db
          .prepare(
            `INSERT INTO ${table} (chat_id, role, content, meta, created_at)
             SELECT ?, role, content, meta, created_at FROM ${table} WHERE chat_id = ? ORDER BY id${limit.length ? " LIMIT ?" : ""}`
          )
          .run(id, sourceChatId, ...limit).changes;
      };
      const copied = copyInto("messages");
      copyInto("transcript_messages");
      // Clamping the count would leave recap text about discarded messages.
      const covered = src.prompt_covered_count;
      if (src.prompt_summary?.trim() && Number.isInteger(covered) && covered > 0 && covered <= copied) {
        this.db
          .prepare("UPDATE chats SET prompt_summary = ?, prompt_covered_count = ? WHERE id = ?")
          .run(src.prompt_summary, covered, id);
      }
      return id;
    });
    return tx.immediate();
  }

  getForkParent(chatId: string, userId: string): string | null {
    const row = this.db
      .prepare("SELECT forked_from_chat_id FROM chats WHERE id = ? AND user_id = ?")
      .get(chatId, userId) as { forked_from_chat_id?: string | null } | undefined;
    return row?.forked_from_chat_id ?? null;
  }

  chatExists(chatId: string, userId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM chats WHERE id = ? AND user_id = ?")
      .get(chatId, userId);
  }

  updateChatProject(chatId: string, userId: string, projectId: string | null): boolean {
    const existing = this.db.prepare("SELECT id FROM chats WHERE id = ? AND user_id = ?").get(chatId, userId);
    if (!existing) return false;
    const now = Date.now();
    this.db.prepare("UPDATE chats SET project_id = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(projectId, now, chatId, userId);
    return true;
  }

  touchChatUpdatedAt(chatId: string, userId: string): boolean {
    const existing = this.db.prepare("SELECT id FROM chats WHERE id = ? AND user_id = ?").get(chatId, userId);
    if (!existing) return false;
    this.db.prepare("UPDATE chats SET updated_at = ? WHERE id = ? AND user_id = ?").run(Date.now(), chatId, userId);
    return true;
  }

  getChatMessageTail(chatId: string, userId: string, limit: number): ChatMessageTailItem[] {
    const ok = this.db.prepare("SELECT 1 FROM chats WHERE id = ? AND user_id = ?").get(chatId, userId);
    if (!ok) return [];
    const n = Math.max(1, Math.min(50, Math.floor(limit) || 12));
    const rows = this.db
      .prepare(
        `SELECT role, content, created_at FROM messages
         WHERE chat_id = ?
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(chatId, n) as Array<{ role: string; content: string; created_at: number }>;
    return rows
      .reverse()
      .map((r) => ({
        role: r.role as "user" | "assistant",
        content: r.content,
        created_at: r.created_at,
      }));
  }

  listRecentChatsForInsights(userId: string, excludeChatId: string, limit: number): ChatListItem[] {
    const n = Math.max(1, Math.min(40, Math.floor(limit) || 20));
    const rows = this.db
      .prepare(
        `SELECT id, title, updated_at, project_id, browser_page_key, model, pinned, favorited FROM chats
         WHERE user_id = ? AND id != ?
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(userId, excludeChatId, n) as Array<{
        id: string;
        title: string;
        updated_at: number;
        project_id?: string | null;
        browser_page_key?: string | null;
        model?: string | null;
        pinned?: number | null;
        favorited?: number | null;
      }>;
    return rows.map((r) => mapChatListRow(r));
  }

  recordInsightEvent(event: InsightEventInput): string {
    const id = event.id?.trim() || `ins_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO insight_events
         (id, user_id, chat_id, past_chat_id, status, insight_topic, reason_code, score, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        event.userId,
        event.chatId,
        event.pastChatId ?? null,
        event.status,
        (event.insightTopic ?? "").trim().slice(0, 200),
        event.reasonCode,
        typeof event.score === "number" ? event.score : null,
        now
      );
    return id;
  }

  hasInsightEvent(
    userId: string,
    pastChatId: string | null | undefined,
    reasonCode: string,
    insightTopic: string
  ): boolean {
    const topic = (insightTopic ?? "").trim().slice(0, 200);
    const past = pastChatId ?? null;
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM insight_events
         WHERE user_id = ?
           AND reason_code = ?
           AND insight_topic = ?
           AND ((past_chat_id IS NULL AND ? IS NULL) OR past_chat_id = ?)
           AND status IN ('accepted', 'dismissed')
         LIMIT 1`
      )
      .get(userId, reasonCode, topic, past, past) as { ok: number } | undefined;
    return !!row;
  }

  lastInsightEventAt(chatId: string, userId: string): number | null {
    const row = this.db
      .prepare(
        `SELECT created_at FROM insight_events
         WHERE chat_id = ? AND user_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(chatId, userId) as { created_at: number } | undefined;
    return row?.created_at ?? null;
  }

  deleteChat(chatId: string, userId: string): boolean {
    const ok = this.db.prepare("SELECT 1 FROM chats WHERE id = ? AND user_id = ?").get(chatId, userId);
    if (!ok) return false;
    const parent = this.getForkParent(chatId, userId);
    const del = this.db.transaction(() => {
      // Graft: children forks re-attach to the deleted chat's parent so the fork
      // tree stays connected instead of breaking in the middle of the chain.
      this.db
        .prepare("UPDATE chats SET forked_from_chat_id = ? WHERE forked_from_chat_id = ? AND user_id = ?")
        .run(parent, chatId, userId);
      this.db.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId);
      this.db.prepare("DELETE FROM transcript_messages WHERE chat_id = ?").run(chatId);
      this.db.prepare("DELETE FROM insight_events WHERE chat_id = ? OR past_chat_id = ?").run(chatId, chatId);
      this.db.prepare("DELETE FROM chats WHERE id = ? AND user_id = ?").run(chatId, userId);
    });
    del();
    return true;
  }
}
