import { apiBase, apiKey } from "../config";
import { getAuthHeaders } from "../auth/storage";
import { getConfig, putConfig } from "./config";

function headers(): Record<string, string> {
  const h: Record<string, string> = { ...getAuthHeaders() };
  if (apiKey) {
    h["X-API-Key"] = apiKey;
    if (!h["Authorization"]) h["Authorization"] = `Bearer ${apiKey}`;
  }
  return h;
}

export interface LlmModelsResponse {
  models: string[];
  current: string;
  error?: string;
}

export async function fetchLlmModels(): Promise<LlmModelsResponse> {
  const res = await fetch(`${apiBase}/api/llm/models`, { headers: headers() });
  const data = (await res.json().catch(() => ({}))) as LlmModelsResponse;
  if (!res.ok) {
    return {
      models: Array.isArray(data.models) ? data.models : [],
      current: typeof data.current === "string" ? data.current : "",
      error: data.error || `HTTP ${res.status}`,
    };
  }
  return {
    models: Array.isArray(data.models) ? data.models : [],
    current: typeof data.current === "string" ? data.current : "",
    error: data.error,
  };
}

/** Write llm.model into config (single source of truth — settings/yaml/db). */
export async function setLlmModel(model: string): Promise<string> {
  const trimmed = model.trim();
  if (!trimmed) throw new Error("Empty model");
  const cfg = await getConfig();
  const llm =
    cfg.llm && typeof cfg.llm === "object" && !Array.isArray(cfg.llm)
      ? { ...(cfg.llm as Record<string, unknown>) }
      : {};
  await putConfig({ ...cfg, llm: { ...llm, model: trimmed } });
  return trimmed;
}
