// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, type Locale } from "./types";

export function readStoredLocale(): Locale {
  try {
    const v = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (v === "en" || v === "ru") return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_LOCALE;
}

export function writeStoredLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* ignore */
  }
}
