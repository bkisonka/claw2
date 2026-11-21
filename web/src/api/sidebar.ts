// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { getAuthHeaders } from "../auth/storage";
import { apiKey } from "../config";

export type SidebarItemAction = "prompt" | "navigate" | "url";

export type SidebarItemIcon =
  | "bolt"
  | "file"
  | "folder"
  | "task"
  | "link"
  | "chat"
  | "search"
  | "settings"
  | "star"
  | "spark";

export type SidebarItemStatus = "open" | "active" | "done";

export interface DynamicSidebarItem {
  id: string;
  label: string;
  icon?: SidebarItemIcon;
  action: SidebarItemAction;
  value: string;
  status?: SidebarItemStatus;
  note?: string;
}

export interface DynamicSidebarState {
  title: string;
  items: DynamicSidebarItem[];
  updatedAt: number;
  lastEvent?: {
    type: string;
    id?: string;
    label?: string;
    status?: SidebarItemStatus;
    at: number;
    detail?: string;
  };
}

export async function fetchSidebar(sessionId: string): Promise<DynamicSidebarState> {
  const q = encodeURIComponent(sessionId || "anon");
  const res = await fetch(`/api/sidebar?sessionId=${q}`, {
    headers: apiKey ? { "X-API-Key": apiKey, Authorization: `Bearer ${apiKey}`, ...getAuthHeaders() } : { ...getAuthHeaders() },
  });
  if (!res.ok) throw new Error(`sidebar HTTP ${res.status}`);
  return (await res.json()) as DynamicSidebarState;
}

/** Mark item done + record lastEvent for the model (reinforcement). */
export async function clickSidebarItem(
  sessionId: string,
  itemId: string
): Promise<DynamicSidebarState> {
  const res = await fetch("/api/sidebar/click", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey ? { "X-API-Key": apiKey, Authorization: `Bearer ${apiKey}` } : {}), ...getAuthHeaders() },
    body: JSON.stringify({ sessionId: sessionId || "anon", itemId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `sidebar click HTTP ${res.status}`);
  }
  const data = (await res.json()) as { state: DynamicSidebarState };
  return data.state;
}
