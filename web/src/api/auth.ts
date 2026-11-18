import { apiBase } from "../config";
import { getAuthHeaders } from "../auth/storage";

export interface UserMe {
  id: string;
  login: string;
  email: string | null;
}

export interface LoginResponse {
  ok: boolean;
  user: UserMe;
  token: string;
}

export interface RegisterResponse {
  ok: boolean;
  user: UserMe;
  token: string;
}

function apiHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...getAuthHeaders(),
  };
}

/** Session check: current user. 200 — ok, 401 — unauthorized, 404 — auth not configured on the server. */
export async function fetchMe(): Promise<UserMe | null> {
  const res = await fetch(`${apiBase}/api/me`, { headers: apiHeaders() });
  if (res.status === 404) return null;
  if (res.status === 401) throw new Error("auth_required");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}

/** Sign in. On success returns user and token (persist the token via setToken). */
export async function login(login: string, password: string): Promise<LoginResponse> {
  const res = await fetch(`${apiBase}/api/login`, {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({ login: login.trim(), password }),
  });
  const data = (await res.json().catch(() => ({}))) as LoginResponse & { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** Sign up. On success returns user and token. */
export async function register(login: string, email: string | null, password: string): Promise<RegisterResponse> {
  const res = await fetch(`${apiBase}/api/register`, {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({
      login: login.trim(),
      email: email?.trim() || undefined,
      password,
    }),
  });
  const text = await res.text();
  type RegisterApiResponse = RegisterResponse & { error?: string; hint?: string };
  const data: RegisterApiResponse = (() => {
    try {
      return JSON.parse(text) as RegisterApiResponse;
    } catch {
      return {} as RegisterApiResponse;
    }
  })();
  if (!res.ok) {
    const errMsg = data.error ?? (text || `HTTP ${res.status}`);
    const msg = data.hint ? `${errMsg}. ${data.hint}` : errMsg;
    throw new Error(msg);
  }
  return data as RegisterResponse;
}

/** Sign out (server session is stateless; client removes the token). */
export async function logout(): Promise<void> {
  await fetch(`${apiBase}/api/logout`, { method: "POST", headers: apiHeaders() });
}

/** Change password. Requires Authorization. */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const res = await fetch(`${apiBase}/api/me/password`, {
    method: "PUT",
    headers: apiHeaders(),
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  }
}
