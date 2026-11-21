// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import jwt from "jsonwebtoken";

const DEFAULT_EXPIRES_IN = "7d";

export interface JwtPayload {
  userId: string;
  login: string;
  iat?: number;
  exp?: number;
}

export function signToken(payload: Omit<JwtPayload, "iat" | "exp">, secret: string, expiresIn = DEFAULT_EXPIRES_IN): string {
  return jwt.sign(payload as object, secret, { expiresIn } as jwt.SignOptions);
}

export function verifyToken(token: string, secret: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, secret) as JwtPayload;
    return decoded;
  } catch {
    return null;
  }
}

export function getBearerToken(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const auth = req.headers["authorization"];
  if (typeof auth !== "string") return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}
