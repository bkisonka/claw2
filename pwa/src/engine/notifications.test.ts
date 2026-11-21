// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => {
  const store = new Map<string, Record<string, unknown>>();
  return {
    putReminder: vi.fn(async (r: Record<string, unknown> & { id: string }) => {
      store.set(r.id, r);
    }),
    getReminder: vi.fn(async (id: string) => store.get(id)),
    allReminders: vi.fn(async () => [...store.values()]),
  };
});

import {
  cancelReminderById,
  expireAt,
  EXPIRE_AFTER_MS,
  ladderTimes,
  nextReissueAt,
  REISSUE_INTERVAL_MS,
  remindersContextBlock,
  scheduleReminder,
  toolSetReminder,
} from "./notifications";

const HOUR = 60 * 60 * 1000;
const now = () => Date.now();

beforeAll(() => {
  const backing = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
  });
});

beforeEach(() => {
  vi.mocked(localStorage.setItem).mockClear?.();
});

describe("ladderTimes (лестница пере-выдач)", () => {
  it("full ladder for a future reminder: 12 steps, 2h apart, all before expiry", () => {
    const due = now() + HOUR;
    const times = ladderTimes(due);
    expect(times).toHaveLength(12);
    expect(times[0]).toBe(due);
    expect(times[1] - times[0]).toBe(REISSUE_INTERVAL_MS);
    expect(times[times.length - 1]).toBe(due + 22 * HOUR);
    expect(times[times.length - 1]).toBeLessThan(expireAt(due));
  });

  it("skips steps already in the past (mid-window re-arm)", () => {
    const due = now() - 3 * HOUR; // +24h окно ещё не истекло
    const times = ladderTimes(due);
    expect(times[0]).toBe(due + 4 * HOUR); // первый будущий момент
    expect(times.every((t) => t > now())).toBe(true);
  });

  it("is empty once the 24h window has passed", () => {
    expect(ladderTimes(now() - 25 * HOUR)).toEqual([]);
  });

  it("never schedules at or beyond the expiry boundary", () => {
    const due = now() + HOUR;
    for (const t of ladderTimes(due)) expect(t).toBeLessThan(expireAt(due));
  });
});

describe("timing helpers", () => {
  it("expireAt = dueAt + 24h", () => {
    const due = now() + HOUR;
    expect(expireAt(due)).toBe(due + EXPIRE_AFTER_MS);
  });

  it("nextReissueAt respects the 2h spacing floor", () => {
    const t = now();
    expect(nextReissueAt(t, t + HOUR)).toBe(t + HOUR + REISSUE_INTERVAL_MS);
    expect(nextReissueAt(t, t - 5 * HOUR)).toBe(t); // пауза давно прошла — выдаём сразу
  });
});

describe("schedule/cancel lifecycle (web path, plugin mocked)", () => {
  it("schedules a future reminder: 12 notification ids, status scheduled", async () => {
    const r = await scheduleReminder("позвонить маме", now() + HOUR, "sess_test");
    expect(r.status).toBe("scheduled");
    expect(r.notifIds).toHaveLength(12);
    expect(new Set(r.notifIds).size).toBe(12); // id уникальны — лестница живёт
    expect(r.lastIssuedAt).toBe(r.dueAt);
  });

  it("expires a reminder whose window has passed", async () => {
    const r = await scheduleReminder("старое", now() - 25 * HOUR, "sess_test");
    expect(r.status).toBe("expired");
    expect(r.notifIds).toHaveLength(0);
  });

  it("cancel marks the reminder canceled", async () => {
    const r = await scheduleReminder("отменить меня", now() + HOUR, "sess_test");
    const done = await cancelReminderById(r.id);
    expect(done?.status).toBe("canceled");
  });

  it("context block lists active and expired-unread reminders", async () => {
    const r = await scheduleReminder("вынести мусор", now() + 2 * HOUR, "sess_test");
    await scheduleReminder("непрочитанное", now() - 25 * HOUR, "sess_test");
    const block = await remindersContextBlock();
    expect(block).toContain(r.id);
    expect(block).toContain("вынести мусор");
    expect(block).toContain("не прочитан");
  });
});

describe("toolSetReminder (model-facing)", () => {
  it("rejects an invalid datetime and asks to clarify", async () => {
    const res = await toolSetReminder("напомни", "не дата", "sess_test");
    expect(res.content).toContain("YYYY-MM-DDTHH:mm");
  });

  it("rejects a past datetime and asks to clarify", async () => {
    const res = await toolSetReminder("напомни", "2020-01-01T09:00", "sess_test");
    expect(res.content).toContain("в прошлом");
  });

  it("schedules and returns the id + local time confirmation", async () => {
    const due = new Date(now() + 3 * HOUR);
    const iso = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}T${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}`;
    const res = await toolSetReminder("полить цветы", iso, "sess_test");
    expect(res.content).toContain("Напоминание установлено");
    expect(res.content).toContain("полить цветы");
    expect(res.content).toMatch(/id=rem_/);
  });
});
