// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Persistent call logs for SIP phone_call sessions.
 * Stored as JSON under .claw2/data/call-logs.json (newest first).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type CallLogEventType =
  | "dial"
  | "ringing"
  | "answer"
  | "connected"
  | "say"
  | "listen"
  | "dtmf"
  | "transfer"
  | "hangup"
  | "end"
  | "error"
  | "call_start"
  | "media_backend"
  | "realtime"
  | "realtime_ttfa"
  | "fallback";

export type CallLogEvent = {
  at: string;
  type: CallLogEventType;
  text?: string;
  detail?: string;
};

export type CallLogRecord = {
  id: string;
  startedAt: string;
  endedAt?: string;
  direction: "out" | "in";
  remote: string;
  state: "active" | "ended" | "failed";
  events: CallLogEvent[];
};

export type CallLogSummary = {
  id: string;
  startedAt: string;
  endedAt?: string;
  direction: "out" | "in";
  remote: string;
  state: CallLogRecord["state"];
  eventCount: number;
  preview?: string;
};

const MAX_CALLS = 200;

function defaultLogPath(): string {
  return join(process.cwd(), ".claw2", "data", "call-logs.json");
}

function resolveLogPath(): string {
  const env = process.env.CLAW2_CALL_LOGS_PATH?.trim();
  return env || defaultLogPath();
}

function readAll(): CallLogRecord[] {
  const path = resolveLogPath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as { calls?: CallLogRecord[] } | CallLogRecord[];
    if (Array.isArray(data)) return data;
    return Array.isArray(data.calls) ? data.calls : [];
  } catch {
    return [];
  }
}

function writeAll(calls: CallLogRecord[]): void {
  const path = resolveLogPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ calls }, null, 2), "utf-8");
}

function previewFrom(record: CallLogRecord): string | undefined {
  for (let i = record.events.length - 1; i >= 0; i--) {
    const e = record.events[i];
    if ((e.type === "say" || e.type === "listen") && e.text?.trim()) {
      const t = e.text.trim();
      return t.length > 80 ? `${t.slice(0, 77)}…` : t;
    }
  }
  return undefined;
}

export function listCallLogs(): CallLogSummary[] {
  return readAll().map((c) => ({
    id: c.id,
    startedAt: c.startedAt,
    endedAt: c.endedAt,
    direction: c.direction,
    remote: c.remote,
    state: c.state,
    eventCount: c.events.length,
    preview: previewFrom(c),
  }));
}

export function listCallLogRecords(): CallLogRecord[] {
  return readAll();
}

export function getCallLog(id: string): CallLogRecord | null {
  return readAll().find((c) => c.id === id) ?? null;
}

export function startCallLog(input: {
  direction: "out" | "in";
  remote: string;
  id?: string;
}): CallLogRecord {
  const record: CallLogRecord = {
    id: input.id || randomUUID(),
    startedAt: new Date().toISOString(),
    direction: input.direction,
    remote: input.remote,
    state: "active",
    events: [
      {
        at: new Date().toISOString(),
        type: input.direction === "out" ? "dial" : "ringing",
        detail: input.remote,
      },
    ],
  };
  const all = readAll().filter((c) => c.id !== record.id);
  all.unshift(record);
  writeAll(all.slice(0, MAX_CALLS));
  return record;
}

export function appendCallLogEvent(
  callId: string,
  event: Omit<CallLogEvent, "at"> & { at?: string }
): CallLogRecord | null {
  const all = readAll();
  const idx = all.findIndex((c) => c.id === callId);
  if (idx < 0) return null;
  const rec = all[idx];
  rec.events.push({
    at: event.at || new Date().toISOString(),
    type: event.type,
    text: event.text,
    detail: event.detail,
  });
  if (event.type === "end" || event.type === "hangup") {
    rec.state = rec.state === "failed" ? "failed" : "ended";
    rec.endedAt = rec.endedAt || new Date().toISOString();
  }
  if (event.type === "error" && rec.state === "active") {
    // keep active unless hangup follows
  }
  all[idx] = rec;
  writeAll(all);
  return rec;
}

export function finishCallLog(callId: string, opts?: { failed?: boolean; detail?: string }): void {
  const all = readAll();
  const idx = all.findIndex((c) => c.id === callId);
  if (idx < 0) return;
  const rec = all[idx];
  if (rec.state !== "active" && rec.endedAt) {
    if (opts?.failed && rec.state !== "failed") {
      rec.state = "failed";
      all[idx] = rec;
      writeAll(all);
    }
    return;
  }
  if (opts?.failed) rec.state = "failed";
  else if (rec.state === "active") rec.state = "ended";
  rec.endedAt = rec.endedAt || new Date().toISOString();
  rec.events.push({
    at: new Date().toISOString(),
    type: opts?.failed ? "error" : "end",
    detail: opts?.detail,
  });
  all[idx] = rec;
  writeAll(all);
}

export function callLogToMarkdown(record: CallLogRecord): string {
  const dir = record.direction === "out" ? "outbound" : "inbound";
  const lines: string[] = [
    `# Call ${record.id}`,
    "",
    `- **Direction:** ${dir}`,
    `- **Remote:** ${record.remote}`,
    `- **Started:** ${record.startedAt}`,
    `- **Ended:** ${record.endedAt || "—"}`,
    `- **State:** ${record.state}`,
    "",
    "## Timeline",
    "",
  ];
  for (const e of record.events) {
    const bits = [`**${e.at}**`, `\`${e.type}\``];
    if (e.text) bits.push(e.text);
    if (e.detail && e.detail !== e.text) bits.push(`_(${e.detail})_`);
    lines.push(`- ${bits.join(" — ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function allCallLogsToMarkdown(records: CallLogRecord[]): string {
  if (records.length === 0) {
    return "# Call logs\n\n_No calls recorded._\n";
  }
  const parts = [`# Call logs`, "", `_Exported ${new Date().toISOString()}_`, ""];
  for (const r of records) {
    parts.push(callLogToMarkdown(r));
    parts.push("---", "");
  }
  return parts.join("\n");
}
