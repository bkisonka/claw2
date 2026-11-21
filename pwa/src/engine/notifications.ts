// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Напоминания: системные локальные уведомления (@capacitor/local-notifications),
 * автономно — без фонового JS и внешних серверов.
 *
 * Механика: при создании заранее строится «лестница» пере-выдач — из-за
 * особенностей AlarmManager (будильники с одним id замещают друг друга) шаги
 * обязаны иметь разные id: at, +2ч … +22ч (12 шагов, все с allowWhileIdle,
 * RTC_WAKEUP — срабатывают даже при убитом приложении). Тап по уведомлению =
 * прочитано (все pending шаги отменяются, запись помечается read). Смахивание
 * не убивает лестницу (контент уведомления едет в Intent'е будильника), и
 * следующий шаг срабатывает сам — шаги разнесены на 2 часа («не чаще 1 раза
 * в 2 часа»). Пока уведомление висит нетронутым, новые шаги его поднимают
 * наверх шелухи (notification.when = now); при открытии приложения дубли
 * чистятся, остаётся самая свежая. Через 24 часа без прочтения — экспирация:
 * pending отменяются, из трея убирается, запись остаётся в БД со статусом
 * expired (видна модели в контексте).
 */

import { LocalNotifications, type DeliveredNotificationSchema, type LocalNotificationSchema } from "@capacitor/local-notifications";
import { isNative } from "../native";
import { allReminders, getReminder, putReminder, type Reminder } from "./db";
import type { ToolOutcome } from "./tools";

export const REMINDER_CHANNEL_ID = "reminders";
export const REISSUE_INTERVAL_MS = 2 * 60 * 60 * 1000; // «не чаще 1 раза в 2 часа»
export const EXPIRE_AFTER_MS = 24 * 60 * 60 * 1000;    // пере-выдачи в течение 24 часов

const NOTIF_SEQ_KEY = "claw2_notif_seq";

/** Шаги лестницы: dueAt, dueAt+2ч … dueAt+22ч; прошедшие моменты не планируются. */
export function ladderTimes(dueAt: number, now: number = Date.now()): number[] {
  const times: number[] = [];
  for (let offset = 0; offset < EXPIRE_AFTER_MS; offset += REISSUE_INTERVAL_MS) {
    const t = dueAt + offset;
    if (t > now) times.push(t);
  }
  return times;
}

/** Срок экспирации. */
export function expireAt(dueAt: number): number {
  return dueAt + EXPIRE_AFTER_MS;
}

/** Следующий допустимый момент выдачи с учётом «не чаще 1 раза в 2 часа». */
export function nextReissueAt(now: number, lastIssuedAt: number): number {
  return Math.max(now, lastIssuedAt + REISSUE_INTERVAL_MS);
}

function nextNotifId(): number {
  const cur = Number(localStorage.getItem(NOTIF_SEQ_KEY) ?? "1000") + 1;
  localStorage.setItem(NOTIF_SEQ_KEY, String(cur));
  return cur;
}

function notifText(r: Reminder): { title: string; body: string } {
  const when = new Date(r.dueAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return { title: "Напоминание", body: `${r.text}\n(на ${when})` };
}

/** Канал «Напоминания» + обработчик тапов (тап = прочитано). */
export async function initNotifications(): Promise<void> {
  if (!isNative()) return;
  await LocalNotifications.createChannel({
    id: REMINDER_CHANNEL_ID,
    name: "Напоминания",
    description: "Напоминания от ассистента",
    // Importance — union 0..5 (шкала Android): 5 = high (звук/голова шелухи)
    importance: 5,
    vibration: true,
  }).catch(() => {});
  LocalNotifications.addListener("localNotificationActionPerformed", (action) => {
    void handleTapNotification(action.notification.id);
  }).catch(() => {});
}

/** Построить/пересобрать лестницу выдач напоминания от текущего момента. */
async function armReminder(reminder: Reminder): Promise<Reminder> {
  const now = Date.now();
  if (now >= expireAt(reminder.dueAt)) {
    reminder.status = "expired";
    await putReminder(reminder);
    return reminder;
  }
  const start = Math.max(now, nextReissueAt(now, reminder.lastIssuedAt));
  const times = reminder.lastIssuedAt
    ? ladderTimes(start, now)
    : ladderTimes(reminder.dueAt, now);
  const ids = times.map(() => nextNotifId());
  reminder.notifIds = ids;
  reminder.lastIssuedAt = times[0] ?? reminder.lastIssuedAt;
  reminder.status = times.length ? "scheduled" : "expired";
  if (isNative() && times.length) {
    const notifications: LocalNotificationSchema[] = times.map((t, i) => ({
      id: ids[i],
      title: notifText(reminder).title,
      body: notifText(reminder).body,
      schedule: { at: new Date(t), allowWhileIdle: true },
      channelId: REMINDER_CHANNEL_ID,
      extra: { reminderId: reminder.id },
    }));
    await LocalNotifications.schedule({ notifications });
  }
  await putReminder(reminder);
  return reminder;
}

/** Отменить pending-будильники и снять уведомления из трея по id-шникам. */
async function disarmNotifications(notifIds: number[]): Promise<void> {
  if (!isNative() || !notifIds.length) return;
  const byId = notifIds.map((id) => ({ id })) as unknown as DeliveredNotificationSchema[];
  await LocalNotifications.cancel({ notifications: byId }).catch(() => {});
  await LocalNotifications.removeDeliveredNotifications({ notifications: byId }).catch(() => {});
}

export async function scheduleReminder(text: string, dueAt: number, chatId: string): Promise<Reminder> {
  const reminder: Reminder = {
    id: `rem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    chatId,
    text,
    dueAt,
    createdAt: Date.now(),
    status: "scheduled",
    notifIds: [],
    lastIssuedAt: 0,
  };
  await putReminder(reminder);
  return await armReminder(reminder);
}

export async function cancelReminderById(id: string): Promise<Reminder | null> {
  const reminder = await getReminder(id);
  if (!reminder) return null;
  await disarmNotifications(reminder.notifIds);
  reminder.status = "canceled";
  await putReminder(reminder);
  return reminder;
}

/** Тап по уведомлению = прочитано: снять всё оставшееся, пометить read. */
export async function handleTapNotification(notifId: number): Promise<Reminder | null> {
  const all = await allReminders();
  const reminder = all.find((r) => r.notifIds.includes(notifId));
  if (!reminder || reminder.status === "read" || reminder.status === "canceled") return reminder ?? null;
  await disarmNotifications(reminder.notifIds);
  reminder.status = "read";
  reminder.readAt = Date.now();
  await putReminder(reminder);
  return reminder;
}

/**
 * Сверка при открытии/возобновлении приложения. Проводит статусы scheduled→fired,
 * экспирирует просроченные (24ч без прочтения — запись остаётся), снимает дубли
 * из трея (остаётся самая свежая). Лестница НЕ трогается: смахивание — и
 * следующий шаг сработает сам.
 */
export async function reconcileReminders(): Promise<void> {
  if (!isNative()) return;
  const all = await allReminders();
  const active = all.filter((r) => r.status === "scheduled" || r.status === "fired");
  if (!active.length) return;
  const now = Date.now();
  const delivered = await LocalNotifications.getDeliveredNotifications().catch(() => ({ notifications: [] }));
  const deliveredIds = new Set((delivered.notifications ?? []).map((n) => n.id));
  for (const r of active) {
    if (now < r.dueAt) continue; // ещё ждёт своего времени
    if (now >= expireAt(r.dueAt)) {
      await disarmNotifications(r.notifIds);
      r.status = "expired";
      await putReminder(r);
      continue;
    }
    r.status = "fired";
    const inTray = r.notifIds.some((id) => deliveredIds.has(id));
    if (inTray && r.notifIds.length > 1) {
      // дубли, пролезшие до сверки: снять все кроме самой свежей (последний id)
      await LocalNotifications.removeDeliveredNotifications({
        notifications: r.notifIds.slice(0, -1).map((id) => ({ id })) as unknown as DeliveredNotificationSchema[],
      }).catch(() => {});
    }
    await putReminder(r);
  }
}

/* ---------- инструменты для модели ---------- */

const fmtLocal = (ts: number): string =>
  new Date(ts).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

function formatUntil(ts: number): string {
  const ms = ts - Date.now();
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `через ${mins} мин`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  if (hours < 24) return `через ${hours} ч${rest ? ` ${rest} мин` : ""}`;
  return `через ${Math.floor(hours / 24)} дн ${hours % 24} ч`;
}

export async function toolSetReminder(text: string, datetime: string, chatId: string): Promise<ToolOutcome> {
  const what = text.trim();
  if (!what) return { content: "Нечего напоминать: не указан текст напоминания." };
  const dueAt = new Date(datetime.trim()).getTime();
  if (!Number.isFinite(dueAt)) {
    return { content: "Некорректная дата. Уточни у пользователя точные дату и время и передай datetime как 'YYYY-MM-DDTHH:mm' (локальное время)." };
  }
  if (dueAt < Date.now() + 30_000) {
    return { content: `Дата ${fmtLocal(dueAt)} уже в прошлом. Уточни у пользователя корректное время.` };
  }
  if (isNative()) {
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== "granted") {
      const req = await LocalNotifications.requestPermissions();
      if (req.display !== "granted") {
        return { content: "Пользователь запретил уведомления. Попроси разрешить их для приложения в настройках системы, затем повтори." };
      }
    }
  }
  const reminder = await scheduleReminder(what, dueAt, chatId);
  const where = isNative() ? "" : " (уведомления работают только в приложении — это веб-версия)";
  return {
    content: `Напоминание установлено: «${what}» на ${fmtLocal(reminder.dueAt)} (${formatUntil(reminder.dueAt)})${where}. id=${reminder.id}. Подтверди пользователю время.`,
  };
}

export async function toolCancelReminder(idOrText: string): Promise<ToolOutcome> {
  const q = idOrText.trim();
  if (!q) return { content: "Не указано, что отменить: id напоминания или кусок его текста." };
  const direct = await cancelReminderById(q);
  if (direct) return { content: `Напоминание ${direct.id} «${direct.text}» отменено, уведомления сняты.` };
  const all = await allReminders();
  const needle = q.toLowerCase();
  const active = all.filter((r) => r.status === "scheduled" || r.status === "fired");
  const matches = active.filter((r) => r.text.toLowerCase().includes(needle));
  if (!matches.length) return { content: "Активных напоминаний с таким текстом нет. Смотри список в контексте." };
  if (matches.length > 1) {
    return { content: `Несколько подходящих напоминаний — уточни id: ${matches.map((m) => `${m.id} «${m.text}»`).join("; ")}` };
  }
  const done = await cancelReminderById(matches[0].id);
  return { content: `Напоминание «${done?.text}» отменено, уведомления сняты.` };
}

/** Блок контекста: активные напоминания и нечитанные-истёкшие (память о них). */
export async function remindersContextBlock(): Promise<string> {
  const all = await allReminders();
  const now = Date.now();
  const active = all.filter((r) => (r.status === "scheduled" || r.status === "fired") && now < expireAt(r.dueAt));
  const expired = all.filter((r) => r.status === "expired").slice(-5);
  const canceled = all.filter((r) => r.status === "canceled").slice(-3);
  if (!active.length && !expired.length) return "";
  const lines: string[] = [];
  if (active.length) {
    lines.push("Активные напоминания (id, текст, статус):");
    for (const r of active.slice(0, 20)) {
      const status = now >= r.dueAt ? "выдано, ждёт прочтения (пере-выдача каждые 2ч)" : `будет выдано ${fmtLocal(r.dueAt)}`;
      lines.push(`- ${r.id} «${r.text}» — ${status}`);
    }
  }
  if (expired.length) {
    lines.push("Не прочитанные за 24ч (сняты с выдачи, но ты помнишь о них):");
    for (const r of expired) lines.push(`- ${r.id} «${r.text}» — было на ${fmtLocal(r.dueAt)}, так и не прочитано`);
  }
  if (canceled.length) {
    lines.push(`Недавно отменены: ${canceled.map((r) => `«${r.text}»`).join(", ")}.`);
  }
  return lines.join("\n");
}
