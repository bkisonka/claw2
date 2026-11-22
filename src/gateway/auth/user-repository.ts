// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import type { Pool } from "pg";
import bcrypt from "bcrypt";

const SALT_ROUNDS = 10;

export interface UserRow {
  id: string;
  login: string;
  email: string | null;
  password_hash: string;
  tenant_id: string | null;
  status: string;
  /** Bumped on password change; JWTs carry the value at issue time. */
  token_version: number;
  created_at: Date;
}

export interface UserPublic {
  id: string;
  login: string;
  email: string | null;
}

export interface CreateUserInput {
  login: string;
  email?: string | null;
  password: string;
  tenant_id?: string | null;
  status?: string;
}

export class AuthRepository {
  constructor(private pool: Pool) {}

  async initSchema(): Promise<void> {
    const { initAuthSchema } = await import("./pool.js");
    await initAuthSchema(this.pool);
  }

  async ensureSchema(): Promise<void> {
    await this.initSchema();
  }

  async createUser(input: CreateUserInput): Promise<UserRow> {
    const hash = await bcrypt.hash(input.password, SALT_ROUNDS);
    const res = await this.pool.query<UserRow>(
      `INSERT INTO users (login, email, password_hash, tenant_id, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, login, email, password_hash, tenant_id, status, token_version, created_at`,
      [
        input.login.trim().toLowerCase(),
        input.email?.trim() || null,
        hash,
        input.tenant_id ?? null,
        input.status ?? "active",
      ]
    );
    return res.rows[0]!;
  }

  async findByLogin(login: string): Promise<UserRow | null> {
    const res = await this.pool.query<UserRow>(
      "SELECT id, login, email, password_hash, tenant_id, status, token_version, created_at FROM users WHERE login = $1",
      [login.trim().toLowerCase()]
    );
    return res.rows[0] ?? null;
  }

  async findById(id: string): Promise<UserRow | null> {
    const res = await this.pool.query<UserRow>(
      "SELECT id, login, email, password_hash, tenant_id, status, token_version, created_at FROM users WHERE id = $1",
      [id]
    );
    return res.rows[0] ?? null;
  }

  async checkLoginExists(login: string): Promise<boolean> {
    const res = await this.pool.query(
      "SELECT 1 FROM users WHERE login = $1 LIMIT 1",
      [login.trim().toLowerCase()]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async checkEmailExists(email: string): Promise<boolean> {
    const res = await this.pool.query(
      "SELECT 1 FROM users WHERE email = $1 LIMIT 1",
      [email.trim().toLowerCase()]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async verifyPassword(user: UserRow, password: string): Promise<boolean> {
    return bcrypt.compare(password, user.password_hash);
  }

  async updatePassword(userId: string, newPassword: string): Promise<boolean> {
    const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    // token_version bump invalidates every JWT issued before the change.
    const res = await this.pool.query(
      "UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2",
      [hash, userId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Current account state for token verification (status + token_version). */
  async getAuthState(userId: string): Promise<{ status: string; tokenVersion: number } | null> {
    const res = await this.pool.query<{ status: string; token_version: number }>(
      "SELECT status, token_version FROM users WHERE id = $1",
      [userId]
    );
    const row = res.rows[0];
    if (!row) return null;
    return { status: row.status, tokenVersion: Number(row.token_version ?? 0) };
  }

  async getUserConfig(userId: string): Promise<Record<string, unknown> | null> {
    const res = await this.pool.query<{ config: unknown }>(
      "SELECT config FROM user_config WHERE user_id = $1",
      [userId]
    );
    const row = res.rows[0];
    if (!row || row.config == null) return null;
    return typeof row.config === "object" && row.config !== null
      ? (row.config as Record<string, unknown>)
      : null;
  }

  async setUserConfig(userId: string, config: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `INSERT INTO user_config (user_id, config, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (user_id) DO UPDATE SET config = $2::jsonb, updated_at = now()`,
      [userId, JSON.stringify(config)]
    );
  }

  toPublic(user: UserRow): UserPublic {
    return { id: user.id, login: user.login, email: user.email };
  }
}
