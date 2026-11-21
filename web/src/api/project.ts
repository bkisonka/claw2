// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { apiBase, apiKey } from "../config";
import { getAuthHeaders } from "../auth/storage";
import { t } from "../i18n";

export interface ProjectListItemApi {
  id: string;
  name: string;
  description: string;
  created_at: number;
  updated_at: number;
}

function projectHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    ...getAuthHeaders(),
    "X-User-Id": "default",
  };
  if (apiKey) {
    h["X-API-Key"] = apiKey;
    if (!h["Authorization"]) h["Authorization"] = `Bearer ${apiKey}`;
  }
  return h;
}

function normalizeProject(data: Partial<ProjectListItemApi> & { error?: string }): ProjectListItemApi {
  return {
    id: data.id ?? "",
    name: data.name ?? t("chat.projectFallback"),
    description: typeof data.description === "string" ? data.description : "",
    created_at: data.created_at ?? Date.now(),
    updated_at: data.updated_at ?? Date.now(),
  };
}

/** List of the user's projects. */
export async function fetchProjectList(): Promise<ProjectListItemApi[]> {
  const url = `${apiBase}/project/list`;
  const res = await fetch(url, { method: "GET", headers: projectHeaders() });
  const data = (await res.json().catch(() => ({}))) as {
    projects?: ProjectListItemApi[];
    error?: string;
  };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return Array.isArray(data.projects) ? data.projects.map((p) => normalizeProject(p)) : [];
}

/** Create a project. Returns the created project. */
export async function createProject(name: string, description = ""): Promise<ProjectListItemApi> {
  const url = `${apiBase}/project`;
  const res = await fetch(url, {
    method: "POST",
    headers: projectHeaders(),
    body: JSON.stringify({
      name: (name || t("chat.projectFallback")).trim() || t("chat.projectFallback"),
      description: description.trim(),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as ProjectListItemApi & { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return normalizeProject(data);
}

/** Update the project name and/or description (goal). */
export async function updateProject(
  projectId: string,
  patch: { name?: string; description?: string }
): Promise<ProjectListItemApi> {
  const url = `${apiBase}/project`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: projectHeaders(),
    body: JSON.stringify({ project_id: projectId, ...patch }),
  });
  const data = (await res.json().catch(() => ({}))) as ProjectListItemApi & { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return normalizeProject(data);
}

/** Delete a project. Succeeds only if the project has no chats. */
export async function deleteProject(projectId: string): Promise<boolean> {
  const url = `${apiBase}/project?project_id=${encodeURIComponent(projectId)}`;
  const res = await fetch(url, { method: "DELETE", headers: projectHeaders() });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.ok === true;
}
