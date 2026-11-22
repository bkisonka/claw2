// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * JWT storage in localStorage. Used by API modules for the Authorization header.
 */
const TOKEN_KEY = "claw2_token";
const listeners = new Set<() => void>();

export function onStoredTokenChange(listener: () => void): void {
  listeners.add(listener);
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  const changed = getToken() !== token;
  if (token == null) {
    localStorage.removeItem(TOKEN_KEY);
  } else {
    localStorage.setItem(TOKEN_KEY, token);
  }
  if (changed) for (const listener of listeners) listener();
}

/** Request headers: Authorization Bearer when a token is present. Merge into fetch headers. */
export function getAuthHeaders(): Record<string, string> {
  const token = getToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}
