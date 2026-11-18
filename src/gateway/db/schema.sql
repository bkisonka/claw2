-- Portable chat schema (SQLite).
-- For PostgreSQL: replace INTEGER PRIMARY KEY AUTOINCREMENT with SERIAL/BIGSERIAL,
-- unix epoch ms leave or go to TIMESTAMPTZ.

-- Users (for the future of multi-user)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- Projects: a group of chats with a common goal (description)
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);

-- Chats: id = sessionId from API; project_id - optional binding to the project
-- prompt_summary / prompt_covered_count - compression cache for LLM (UI messages tape is not overwritten)
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  browser_page_key TEXT,
  /** Per-chat LLM model override; NULL = use settings default. */
  model TEXT,
  /** 1 = pinned to top of sidebar. */
  pinned INTEGER NOT NULL DEFAULT 0,
  /** 1 = favorited (star). */
  favorited INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  prompt_summary TEXT,
  prompt_covered_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE INDEX IF NOT EXISTS idx_chats_user_updated ON chats(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_id, updated_at DESC);

-- Messages (role, content, meta = JSON for cells, etc.)
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  meta TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (chat_id) REFERENCES chats(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id, id);

-- Append-only transcript: not deleted when context_summarize (UI messages feed is not overwritten either).
CREATE TABLE IF NOT EXISTS transcript_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  meta TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (chat_id) REFERENCES chats(id)
);

CREATE INDEX IF NOT EXISTS idx_transcript_chat_id ON transcript_messages(chat_id, id);

-- Dialogue Insights: accept/dismiss meta (no full insight text)
CREATE TABLE IF NOT EXISTS insight_events (
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
);

CREATE INDEX IF NOT EXISTS idx_insight_events_user_past
  ON insight_events(user_id, past_chat_id, reason_code, insight_topic);

CREATE INDEX IF NOT EXISTS idx_insight_events_chat_created
  ON insight_events(chat_id, created_at DESC);
