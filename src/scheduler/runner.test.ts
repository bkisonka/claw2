// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { afterEach, expect, it, vi } from "vitest";
import type { Claw2Config } from "../config/types.js";
import { sendNotifyToOwner } from "../channels/telegram.js";
import { reminderMarkSent, remindersGetDue } from "../tasks/store.js";
import { startScheduler } from "./runner.js";

vi.mock("../channels/telegram.js", () => ({ sendNotifyToOwner: vi.fn() }));
vi.mock("../tasks/store.js", () => ({ remindersGetDue: vi.fn(), reminderMarkSent: vi.fn() }));

const config = { scheduler: { enabled: true } } as Claw2Config;
const reminder = {
  id: 1, taskId: 1, type: "daily" as const, taskText: "test", runAt: "2026-11-22T16:00:00.000Z", createdAt: "",
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it("does not start another batch before a slow send completes", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(remindersGetDue).mockReturnValueOnce([reminder]).mockReturnValue([]);
  let complete!: (result: { ok: true }) => void;
  vi.mocked(sendNotifyToOwner).mockReturnValue(new Promise((resolve) => { complete = resolve; }));

  startScheduler(config);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(remindersGetDue).toHaveBeenCalledTimes(1);
  expect(sendNotifyToOwner).toHaveBeenCalledTimes(1);
  expect(reminderMarkSent).not.toHaveBeenCalled();

  complete({ ok: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(reminderMarkSent).toHaveBeenCalledExactlyOnceWith(config, reminder);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(remindersGetDue).toHaveBeenCalledTimes(2);
  expect(sendNotifyToOwner).toHaveBeenCalledTimes(1);
});

it("leaves unsuccessful sends due and resumes polling after failures", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(remindersGetDue).mockReturnValue([reminder]);
  vi.mocked(sendNotifyToOwner)
    .mockResolvedValueOnce({ ok: false, error: "delivery failed" })
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ ok: true });

  startScheduler(config);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sendNotifyToOwner).toHaveBeenCalledTimes(2);
  expect(reminderMarkSent).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(60_000);
  expect(sendNotifyToOwner).toHaveBeenCalledTimes(3);
  expect(reminderMarkSent).toHaveBeenCalledExactlyOnceWith(config, reminder);
});
