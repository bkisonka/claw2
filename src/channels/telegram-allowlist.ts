/**
 * Access to the Telegram bot via allowlist: owner (ownerId) + approved by invitation.
 * Storage: SQLite (allowed_users, invite_tokens, invite_requests).
 */
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const INVITE_TTL_MS = 10 * 60 * 1000; // 10 minutes

let db: Database.Database | null = null;

function getDbPath(configuredPath: string): string {
  const path = (configuredPath || "").trim();
  if (path) return resolve(path);
  return resolve(process.cwd(), "data", "telegram_allowlist.sqlite");
}

export function initAllowlistDb(configuredPath: string): void {
  if (db) return;
  const dbPath = getDbPath(configuredPath);
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS allowed_users (
      telegram_user_id INTEGER PRIMARY KEY,
      added_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invite_tokens (
      token TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      created_by INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS invite_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL,
      candidate_user_id INTEGER NOT NULL,
      candidate_username TEXT,
      candidate_first_name TEXT,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected'))
    );
    CREATE INDEX IF NOT EXISTS idx_invite_requests_status ON invite_requests(status);
  `);
}

function getDb(): Database.Database {
  if (!db) throw new Error("telegram-allowlist: initAllowlistDb() not called");
  return db;
}

/** Whether the user is allowed (the owner is always allowed; the rest - according to the table).*/
export function isAllowed(telegramUserId: number, ownerId: number): boolean {
  if (telegramUserId === ownerId) return true;
  const row = getDb().prepare("SELECT 1 FROM allowed_users WHERE telegram_user_id = ?").get(telegramUserId);
  return !!row;
}

/** Create a one-time invitation link. Valid for 10 minutes.*/
export function createToken(ownerId: number): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString("hex");
  const created_at = Date.now();
  const expiresAt = created_at + INVITE_TTL_MS;
  getDb()
    .prepare("INSERT INTO invite_tokens (token, created_at, created_by) VALUES (?, ?, ?)")
    .run(token, created_at, ownerId);
  return { token, expiresAt };
}

/** Use token: create a request to join. The token is one-time use, valid for 10 minutes.*/
export function consumeToken(
  token: string,
  candidateUserId: number,
  candidateUsername?: string,
  candidateFirstName?: string
): { ok: true; requestId: number } | { ok: false; reason: string } {
  const database = getDb();
  const row = database.prepare("SELECT created_at, used_at FROM invite_tokens WHERE token = ?").get(token) as
    | { created_at: number; used_at: number | null }
    | undefined;
  if (!row) {
    return { ok: false, reason: "The link is invalid." };
  }
  if (row.used_at != null) {
    return { ok: false, reason: "The link has already been used." };
  }
  const now = Date.now();
  if (now - row.created_at > INVITE_TTL_MS) {
    return { ok: false, reason: "The link has expired." };
  }
  database.prepare("UPDATE invite_tokens SET used_at = ? WHERE token = ?").run(now, token);
  const run = database
    .prepare(
      "INSERT INTO invite_requests (token, candidate_user_id, candidate_username, candidate_first_name, created_at, status) VALUES (?, ?, ?, ?, ?, 'pending')"
    )
    .run(token, candidateUserId, candidateUsername ?? null, candidateFirstName ?? null, now);
  const requestId = run.lastInsertRowid as number;
  return { ok: true, requestId };
}

export function getPendingRequest(requestId: number): {
  candidateUserId: number;
  candidateUsername?: string;
  candidateFirstName?: string;
} | null {
  const row = getDb()
    .prepare("SELECT candidate_user_id, candidate_username, candidate_first_name FROM invite_requests WHERE id = ? AND status = 'pending'")
    .get(requestId) as
    | { candidate_user_id: number; candidate_username: string | null; candidate_first_name: string | null }
    | undefined;
  if (!row) return null;
  return {
    candidateUserId: row.candidate_user_id,
    candidateUsername: row.candidate_username ?? undefined,
    candidateFirstName: row.candidate_first_name ?? undefined,
  };
}

/** Approve the request: add the user to allowed_users. Returns candidate_user_id on success.*/
export function approveRequest(requestId: number): number | null {
  const req = getPendingRequest(requestId);
  if (!req) return null;
  const database = getDb();
  database.prepare("UPDATE invite_requests SET status = 'approved' WHERE id = ?").run(requestId);
  database.prepare("INSERT OR IGNORE INTO allowed_users (telegram_user_id, added_at) VALUES (?, ?)").run(req.candidateUserId, Date.now());
  return req.candidateUserId;
}

/** Reject the application.*/
export function rejectRequest(requestId: number): boolean {
  const req = getPendingRequest(requestId);
  if (!req) return false;
  getDb().prepare("UPDATE invite_requests SET status = 'rejected' WHERE id = ?").run(requestId);
  return true;
}
