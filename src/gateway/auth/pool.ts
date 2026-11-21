// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import pg from "pg";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let pool: pg.Pool | null = null;

export function getAuthPool(databaseUrl: string): pg.Pool {
  if (pool) return pool;
  pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  return pool;
}

export async function initAuthSchema(p: pg.Pool): Promise<void> {
  const schemaPath = join(__dirname, "schema.sql");
  if (!existsSync(schemaPath)) return;
  const sql = readFileSync(schemaPath, "utf-8");
  await p.query(sql);
}

export async function closeAuthPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
