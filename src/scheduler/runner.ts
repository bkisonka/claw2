// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Reminder tick: checks the reminders database once a minute and sends a due to Telegram.
 */
import type { Claw2Config } from "../config/types.js";
import { remindersGetDue, reminderMarkSent } from "../tasks/store.js";
import { sendNotifyToOwner } from "../channels/telegram.js";

const TICK_MS = 60_000;
let running = false;

async function runReminders(config: Claw2Config): Promise<void> {
  // The startup tick and interval share one in-flight batch in this gateway.
  // Don't read due rows again until the previous sends have been recorded.
  if (running) return;
  running = true;
  try {
    const due = remindersGetDue(config);
    if (due.length > 0) {
      console.error(`[scheduler] Reminder tick: ${due.length} due, sending...`);
    }
    for (const r of due) {
      const message = `Reminder:${r.taskText}`;
      const result = await sendNotifyToOwner(config, message);
      if (result.ok) {
        reminderMarkSent(config, r);
      } else {
        console.error("[scheduler] reminder send failed:", r.id, result.error);
      }
    }
  } catch (err) {
    console.error("[scheduler] reminders error:", err);
  } finally {
    running = false;
  }
}

export function startScheduler(config: Claw2Config): void {
  if (!config.scheduler?.enabled) return;
  console.error("Reminder tick started (every 60s)");
  runReminders(config);
  setInterval(() => runReminders(config), TICK_MS);
}
