// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Временная привязка модели. Без текущих даты/времени модель не может
 * развернуть относительные выражения («через 2 часа», «минуту назад»,
 * «завтра в 9») и вынуждена переспрашивать пользователя. Строка строится
 * заново на каждом ходе агента — время в промпте всегда актуально на момент
 * установки напоминания.
 */
export function formatNowContext(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${hhmm}`;
  const weekday = d.toLocaleDateString("ru-RU", { weekday: "long" });
  const human = d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const tz = `UTC${sign}${String(Math.floor(Math.abs(off) / 60)).padStart(2, "0")}:${String(Math.abs(off) % 60).padStart(2, "0")}`;
  return (
    `Сейчас: ${iso} — ${weekday}, ${human}, ${hhmm} (${tz}). ` +
    "Относительные выражения («через N минут/часов», «минуту назад», «10 минут спустя», «сегодня вечером», «завтра утром») разворачивай от этого момента сам — время пользователя не спрашивай."
  );
}
