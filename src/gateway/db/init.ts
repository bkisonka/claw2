// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatRepository } from "./chat-repository.js";
import { SqliteChatRepository } from "./chat-repository.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "schema.sql");

let db: Database.Database | null = null;
let repo: ChatRepository | null = null;

/**
 * Initializes the database along the path: creates a directory if necessary, applies schema.sql.
 * Returns the chat repository. Calling again with the same path returns the same instance.
 */
export function initDb(dbPath: string): ChatRepository {
  if (repo) {
    return repo;
  }
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  db = new Database(dbPath);
  // Migration to schema: in old chats databases there is no project_id; schema creates an index on it and crashes.
  try {
    db.exec("ALTER TABLE chats ADD COLUMN project_id TEXT");
  } catch {
    /* there is no table yet (new database) or the column already exists*/
  }
  try {
    db.exec("ALTER TABLE chats ADD COLUMN prompt_summary TEXT");
  } catch {
    /* there is no table or the column already exists*/
  }
  try {
    db.exec("ALTER TABLE chats ADD COLUMN prompt_covered_count INTEGER NOT NULL DEFAULT 0");
  } catch {
    /* there is no table or the column already exists*/
  }
  try {
    db.exec("ALTER TABLE chats ADD COLUMN browser_page_key TEXT");
  } catch {
    /* there is no table or the column already exists*/
  }
  try {
    db.exec("ALTER TABLE chats ADD COLUMN model TEXT");
  } catch {
    /* there is no table or the column already exists*/
  }
  try {
    db.exec("ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  } catch {
    /* there is no table or the column already exists*/
  }
  try {
    db.exec("ALTER TABLE chats ADD COLUMN favorited INTEGER NOT NULL DEFAULT 0");
  } catch {
    /* there is no table or the column already exists*/
  }
  try {
    db.exec("ALTER TABLE chats ADD COLUMN forked_from_chat_id TEXT");
  } catch {
    /* there is no table or the column already exists*/
  }
  try {
    db.exec("ALTER TABLE chats ADD COLUMN title_manual INTEGER NOT NULL DEFAULT 0");
  } catch {
    /* there is no table or the column already exists*/
  }
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id))"
    );
  } catch {
    /* already there*/
  }
  try {
    db.exec("ALTER TABLE projects ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  } catch {
    /* the column already exists or the table does not exist yet*/
  }
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS insight_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        past_chat_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('accepted', 'dismissed', 'offered')),
        insight_topic TEXT NOT NULL DEFAULT '',
        reason_code TEXT NOT NULL,
        score REAL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_insight_events_user_past ON insight_events(user_id, past_chat_id, reason_code, insight_topic)"
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_insight_events_chat_created ON insight_events(chat_id, created_at DESC)"
    );
  } catch {
    /* already there */
  }
  const schema = readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(schema);
  try {
    db.exec(
      `INSERT INTO transcript_messages (chat_id, role, content, meta, created_at)
       SELECT m.chat_id, m.role, m.content, m.meta, m.created_at FROM messages m
       WHERE NOT EXISTS (
         SELECT 1 FROM transcript_messages t
         WHERE t.chat_id = m.chat_id AND t.created_at = m.created_at
           AND t.role = m.role AND t.content = m.content
       )`
    );
  } catch {
    /* transcript_messages not available yet or already moved*/
  }
  if (process.env.CLAW2_DESKTOP?.trim() === "1") {
    try {
      db.prepare("INSERT INTO users (id, created_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING").run(
        "default",
        Date.now()
      );
      const moved = db.prepare("UPDATE chats SET user_id = 'default' WHERE user_id != 'default'").run();
      if (moved.changes > 0) {
        console.error(`[gateway] desktop chat migrate: ${moved.changes} chat(s) → user_id=default`);
      }
      db.prepare("UPDATE projects SET user_id = 'default' WHERE user_id != 'default'").run();
    } catch (err) {
      console.error(
        "[gateway] desktop chat migrate skipped:",
        err instanceof Error ? err.message : err
      );
    }
  }
  repo = new SqliteChatRepository(db);
  return repo;
}

export function getChatRepository(): ChatRepository | null {
  return repo;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    repo = null;
  }
}
