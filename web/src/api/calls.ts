import { apiBase, apiKey } from "../config";
import { getAuthHeaders } from "../auth/storage";

export type CallLogEvent = {
  at: string;
  type: string;
  text?: string;
  detail?: string;
};

export type CallLogSummary = {
  id: string;
  startedAt: string;
  endedAt?: string;
  direction: "out" | "in";
  remote: string;
  state: "active" | "ended" | "failed";
  eventCount: number;
  preview?: string;
};

export type CallLogRecord = CallLogSummary & {
  events: CallLogEvent[];
};

function headers(): Record<string, string> {
  const h: Record<string, string> = { ...getAuthHeaders() };
  if (apiKey) {
    h["X-API-Key"] = apiKey;
    if (!h["Authorization"]) h["Authorization"] = `Bearer ${apiKey}`;
  }
  return h;
}

export async function fetchCallLogs(): Promise<CallLogSummary[]> {
  const res = await fetch(`${apiBase}/api/calls`, { headers: headers() });
  const data = (await res.json().catch(() => ({}))) as { calls?: CallLogSummary[]; error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return Array.isArray(data.calls) ? data.calls : [];
}

export async function fetchCallLog(id: string): Promise<CallLogRecord> {
  const res = await fetch(`${apiBase}/api/calls/${encodeURIComponent(id)}`, { headers: headers() });
  const data = (await res.json().catch(() => ({}))) as CallLogRecord & { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function downloadMd(url: string, filename: string): Promise<void> {
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text.slice(0, 200) || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

export async function downloadCallLogMd(id: string): Promise<void> {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "call";
  await downloadMd(`${apiBase}/api/calls/${encodeURIComponent(id)}/export.md`, `call-${safe}.md`);
}

export async function downloadAllCallLogsMd(): Promise<void> {
  const name = `call-logs-${new Date().toISOString().slice(0, 10)}.md`;
  await downloadMd(`${apiBase}/api/calls/export.md`, name);
}

export type SipMediaBackendStatus = {
  requested: "auto" | "node" | "sidecar";
  effective: "node" | "sidecar";
  sidecarPath?: string;
  reason: string;
  status: "running" | "not_found" | "fallback" | "node";
};

export type SipStatus = {
  enabled: boolean;
  running: boolean;
  registered: boolean;
  registerError?: string;
  mediaBackend?: SipMediaBackendStatus;
};

export async function fetchSipStatus(): Promise<SipStatus> {
  const res = await fetch(`${apiBase}/api/sip/status`, { headers: headers() });
  const data = (await res.json().catch(() => ({}))) as SipStatus & { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
