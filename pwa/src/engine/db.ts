// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * IndexedDB storage: chats, messages (with attachment metadata), memory chunks.
 * Replaces the gateway's sqlite for the standalone mobile client.
 * Binaries live in the files store; messages reference them by id (schema v4).
 */
import { parseDataUrlToBase64 } from "./files";

export type StoredAttachment = {
  name: string;
  fileId?: string;
  dataUrl?: string;
  mimeType?: string;
  deleted?: boolean;
};

export type StoredMessage = {
  id?: number;
  chatId: string;
  role: "user" | "assistant";
  content: string;
  cells?: { type: string; content: string }[];
  /**
   * Attachment metadata. The binary lives in the files store (fileId) — since
   * schema v4 messages never carry inline base64 (a chat open used to
   * deserialize every attachment of every message: memory spikes, battery).
   * `dataUrl` remains optional only for pre-migration records.
   */
  attachedFiles?: StoredAttachment[];
  createdAt: number;
};

export type ChatSummary = {
  id: string;
  title: string;
  updated_at: number;
  /** Cached recap of the old head of the tape (context retention). */
  promptContext?: { summary: string; coveredCount: number } | null;
  /** Router override: this chat is pinned to one provider (id), router skipped. */
  pinnedProviderId?: string;
};

const DB_NAME = "claw2-mobile";
const DB_VERSION = 4;

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * v3→v4: pull inline base64 out of messages. Attachment dataUrls move into the
 * files store (source: "attachment"), media cells with data: payloads become
 * /files/raw/<id> references. Runs inside the versionchange transaction — a
 * crash mid-migration rolls the whole upgrade back and it re-runs next launch.
 * The cursor keeps memory at one message at a time.
 */
function migrateInlineBinariesToFiles(t: IDBTransaction): void {
  const msgs = t.objectStore("messages");
  const files = t.objectStore("files");
  let seq = 0;
  const newFileId = () => `file_${Date.now()}_${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const cursorReq = msgs.openCursor();
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (!cursor) return;
    const m = cursor.value as StoredMessage;
    let dirty = false;
    // Backfill: user messages get persistent image-preview cells so attached
    // images show in the tape after reloads (previously preview was ephemeral).
    const imageBackfill: { type: string; content: string }[] = [];

    const attachedFiles = m.attachedFiles?.map((f) => {
      if (f.fileId || !f.dataUrl) return f;
      const parsed = parseDataUrlToBase64(f.dataUrl);
      if (!parsed) return f;
      const mime = f.mimeType || parsed.mimeType;
      const id = newFileId();
      files.put({
        id,
        chatId: m.chatId,
        name: f.name,
        mimeType: mime,
        base64: parsed.base64,
        createdAt: m.createdAt ?? Date.now(),
        source: "attachment" as const,
      });
      if (m.role === "user" && mime.startsWith("image/")) {
        imageBackfill.push({ type: "image", content: `/files/raw/${id}` });
      }
      dirty = true;
      const moved: StoredAttachment = {
        name: f.name,
        fileId: id,
        mimeType: mime,
      };
      if (f.deleted) moved.deleted = true;
      return moved;
    });

    const cells = m.cells?.map((c) => {
      if (c.type !== "image" && c.type !== "audio" && c.type !== "video") return c;
      if (!c.content.startsWith("data:")) return c;
      const parsed = parseDataUrlToBase64(c.content);
      if (!parsed) return c;
      const ext = parsed.mimeType.includes("png")
        ? "png"
        : parsed.mimeType.includes("jpeg")
          ? "jpg"
          : parsed.mimeType.includes("webp")
            ? "webp"
            : parsed.mimeType.includes("gif")
              ? "gif"
              : parsed.mimeType.includes("mp4")
                ? "mp4"
                : parsed.mimeType.includes("wav")
                  ? "wav"
                  : parsed.mimeType.startsWith("audio/")
                    ? "audio"
                    : "bin";
      const id = newFileId();
      files.put({
        id,
        chatId: m.chatId,
        name: `${c.type}-${new Date(m.createdAt ?? Date.now()).toISOString().slice(0, 19)}.${ext}`,
        mimeType: parsed.mimeType,
        base64: parsed.base64,
        createdAt: m.createdAt ?? Date.now(),
        source: "agent" as const,
      });
      dirty = true;
      return { type: c.type, content: `/files/raw/${id}` };
    });

    if (dirty) {
      const migratedCells = cells ?? [];
      const nextCells = [...migratedCells, ...imageBackfill];
      cursor.update({ ...m, attachedFiles, cells: nextCells.length > 0 ? nextCells : undefined });
    }
    cursor.continue();
  };
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (!db.objectStoreNames.contains("chats")) {
        const chats = db.createObjectStore("chats", { keyPath: "id" });
        chats.createIndex("updated_at", "updated_at");
      }
      if (!db.objectStoreNames.contains("messages")) {
        const msgs = db.createObjectStore("messages", { keyPath: "id", autoIncrement: true });
        msgs.createIndex("chatId", "chatId");
      }
      if (!db.objectStoreNames.contains("memory")) {
        db.createObjectStore("memory", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("files")) {
        const files = db.createObjectStore("files", { keyPath: "id" });
        files.createIndex("chatId", "chatId");
      }
      if (!db.objectStoreNames.contains("reminders")) {
        db.createObjectStore("reminders", { keyPath: "id" });
      }
      if ((ev as IDBVersionChangeEvent).oldVersion < 4) {
        migrateInlineBinariesToFiles(req.transaction!);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// IDBRequest is invariant in its handler `this` types — `any` is the pragmatic fit here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<any> | void): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store)) as unknown as IDBRequest<T> | undefined;
        t.oncomplete = () => resolve(req?.result as T);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

/**
 * Atomic read-modify-write on one record: get + put inside a single
 * transaction, so concurrent writers cannot lose each other's updates
 * (read-then-write across two tx() calls could).
 */
function mutateRecord<T>(
  store: string,
  key: IDBValidKey,
  mutate: (current: T) => T | null
): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(store, "readwrite");
        const s = t.objectStore(store);
        const getReq = s.get(key);
        getReq.onsuccess = () => {
          const cur = getReq.result as T | undefined;
          if (cur === undefined) return;
          const next = mutate(cur);
          if (next !== null) s.put(next);
        };
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

/** Delete every record of an index in ONE transaction (cursor). */
export function deleteByIndex(store: string, indexName: string, key: IDBValidKey): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(store, "readwrite");
        const idx = t.objectStore(store).index(indexName);
        const cursorReq = idx.openCursor(IDBKeyRange.only(key));
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

const newId = () => `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

export async function listChats(q?: string): Promise<ChatSummary[]> {
  const all = await tx<ChatSummary[]>("chats", "readonly", (s) => s.getAll() as IDBRequest<ChatSummary[]>);
  const sorted = (all ?? []).sort((a, b) => b.updated_at - a.updated_at);
  const needle = q?.trim().toLowerCase();
  return needle ? sorted.filter((c) => c.title.toLowerCase().includes(needle)) : sorted;
}

export async function ensureChat(id: string, firstText?: string): Promise<string> {
  const chatId = id.trim() || newId();
  const existing = await tx<ChatSummary | undefined>("chats", "readonly", (s) => s.get(chatId) as IDBRequest<ChatSummary>);
  if (!existing) {
    const title = (firstText ?? "Новый чат").trim().slice(0, 60) || "Новый чат";
    await tx("chats", "readwrite", (s) => s.put({ id: chatId, title, updated_at: Date.now() }));
  }
  return chatId;
}

export async function getHistory(chatId: string): Promise<StoredMessage[]> {
  const msgs = await tx<StoredMessage[]>("messages", "readonly", (s) =>
    (s.index("chatId") as IDBIndex).getAll(chatId) as IDBRequest<StoredMessage[]>
  );
  return (msgs ?? []).sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}

export async function appendMessage(msg: Omit<StoredMessage, "id">): Promise<number> {
  // One transaction for the message + the chat stamp: every sent message used
  // to commit twice (message tx, then touchChat tx) — double the IDB flushes.
  return openDb().then(
    (db) =>
      new Promise<number>((resolve, reject) => {
        const t = db.transaction(["messages", "chats"], "readwrite");
        const addReq = t.objectStore("messages").add(msg as StoredMessage);
        addReq.onsuccess = () => {
          const chats = t.objectStore("chats");
          const getReq = chats.get(msg.chatId);
          getReq.onsuccess = () => {
            const chat = getReq.result as ChatSummary | undefined;
            if (!chat) return; // chat deleted mid-turn — no orphan stamp
            const next: ChatSummary = { ...chat, updated_at: Date.now() };
            if (msg.role === "user" && (!chat.title || chat.title === "Новый чат")) {
              next.title = (msg.content ?? "").trim().slice(0, 60) || chat.title;
            }
            chats.put(next);
          };
        };
        t.oncomplete = () => resolve(addReq.result as number);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export async function updateMessage(id: number, patch: Partial<StoredMessage>): Promise<void> {
  const cur = await tx<StoredMessage | undefined>("messages", "readonly", (s) => s.get(id) as IDBRequest<StoredMessage>);
  if (cur) await tx("messages", "readwrite", (s) => s.put({ ...cur, ...patch }));
}

async function touchChat(chatId: string, userPreview?: string): Promise<void> {
  await mutateRecord<ChatSummary>("chats", chatId, (chat) => {
    const next: ChatSummary = { ...chat, updated_at: Date.now() };
    if (userPreview && (!chat.title || chat.title === "Новый чат")) {
      next.title = userPreview.trim().slice(0, 60) || chat.title;
    }
    return next;
  });
}

/** Pin this chat to a provider (router skipped) or unpin (null). */
export async function setChatPinnedProvider(chatId: string, providerId: string | null): Promise<void> {
  await mutateRecord<ChatSummary>("chats", chatId, (chat) => {
    const next: ChatSummary = { ...chat, updated_at: Date.now() };
    if (providerId) next.pinnedProviderId = providerId;
    else delete next.pinnedProviderId;
    return next;
  });
}

export async function getChat(chatId: string): Promise<ChatSummary | undefined> {
  return tx<ChatSummary | undefined>("chats", "readonly", (s) => s.get(chatId) as IDBRequest<ChatSummary>);
}

export async function deleteChat(chatId: string): Promise<void> {
  await tx("chats", "readwrite", (s) => s.delete(chatId));
  await deleteByIndex("messages", "chatId", chatId);
}

export async function getPromptContext(chatId: string): Promise<ChatSummary["promptContext"]> {
  const chat = await tx<ChatSummary | undefined>("chats", "readonly", (s) => s.get(chatId));
  return chat?.promptContext ?? null;
}

export async function setPromptContext(chatId: string, summary: string, coveredCount: number): Promise<void> {
  await mutateRecord<ChatSummary>("chats", chatId, (chat) => ({
    ...chat,
    promptContext: { summary, coveredCount },
  }));
}

export async function renameChat(chatId: string, title: string): Promise<void> {
  await touchChat(chatId);
  const chat = await tx<ChatSummary | undefined>("chats", "readonly", (s) => s.get(chatId) as IDBRequest<ChatSummary>);
  if (chat) await tx("chats", "readwrite", (s) => s.put({ ...chat, title: title.trim() || chat.title }));
}

/**
 * Attachments across a chat (for the files/images tabs) — metadata only; the
 * binaries resolve lazily per file via /files/raw/<id>. Media cells are not
 * listed here: since v4 their payloads live in the files store and surface
 * through listFiles().
 */
export async function chatFiles(
  chatId: string
): Promise<{ name: string; mimeType?: string; fileId: string }[]> {
  const msgs = await getHistory(chatId);
  const out: { name: string; mimeType?: string; fileId: string }[] = [];
  for (const m of msgs) {
    for (const f of m.attachedFiles ?? []) {
      if (!f.deleted && f.fileId) out.push({ name: f.name, mimeType: f.mimeType, fileId: f.fileId });
    }
  }
  return out;
}

/* ---------- memory ---------- */

export type MemoryChunk = {
  id: string;
  text: string;
  embedding: number[] | null;
  createdAt: number;
  source: string;
};

export async function remember(chunk: Omit<MemoryChunk, "id" | "createdAt">): Promise<string> {
  const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await tx("memory", "readwrite", (s) => s.put({ ...chunk, id, createdAt: Date.now() } satisfies MemoryChunk));
  return id;
}

export async function allMemory(): Promise<MemoryChunk[]> {
  return (await tx<MemoryChunk[]>("memory", "readonly", (s) => s.getAll() as IDBRequest<MemoryChunk[]>)) ?? [];
}

export async function forgetMemory(id: string): Promise<void> {
  await tx("memory", "readwrite", (s) => s.delete(id));
}

export async function clearMemory(): Promise<void> {
  await tx("memory", "readwrite", (s) => s.clear());
}

export async function memoryCount(): Promise<number> {
  const all = await allMemory();
  return all.length;
}

/* ---------- reminders (напоминания с системными уведомлениями) ---------- */

export type Reminder = {
  id: string;
  chatId: string;
  text: string;
  /** Момент напоминания (epoch ms). */
  dueAt: number;
  createdAt: number;
  /** scheduled → fired → read | expired; canceled — отменено моделью/пользователем. */
  status: "scheduled" | "fired" | "read" | "canceled" | "expired";
  /** id-шники лестницы уведомлений (разные — AlarmManager замещает по id). */
  notifIds: number[];
  /** Момент последней выдачи (spacing «не чаще 1 раза в 2 часа»). */
  lastIssuedAt: number;
  readAt?: number;
};

export async function putReminder(reminder: Reminder): Promise<void> {
  await tx("reminders", "readwrite", (s) => s.put(reminder));
}

export async function getReminder(id: string): Promise<Reminder | undefined> {
  return (await tx<Reminder | undefined>("reminders", "readonly", (s) => s.get(id) as IDBRequest<Reminder>)) ?? undefined;
}

export async function allReminders(): Promise<Reminder[]> {
  const all = (await tx<Reminder[]>("reminders", "readonly", (s) => s.getAll() as IDBRequest<Reminder[]>)) ?? [];
  return all.sort((a, b) => a.dueAt - b.dueAt);
}
