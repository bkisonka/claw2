// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Session stub for stage 1 (no backend).
 * Key in localStorage; later replace with GET /api/me check and a token.
 */

const STORAGE_KEY = "claw2_session";

export function getStubSession(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

export function setStubSession(login: string): void {
  localStorage.setItem(STORAGE_KEY, login);
}

export function clearStubSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Whether there is a "session" for redirecting / to /chat or /login */
export function hasStubSession(): boolean {
  return !!getStubSession();
}
