// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { en, type MessageKey } from "./en";
import { ru } from "./ru";
import { readStoredLocale } from "./storage";
import type { Locale } from "./types";

const catalogs: Record<Locale, Record<MessageKey, string>> = { en, ru };

let currentLocale: Locale = readStoredLocale();

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocaleState(locale: Locale): void {
  currentLocale = locale;
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
}

export type TranslateVars = Record<string, string | number>;

export function translate(key: MessageKey, vars?: TranslateVars, locale?: Locale): string {
  const loc = locale ?? currentLocale;
  let s = catalogs[loc][key] ?? catalogs.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

/** Non-React helper (API, store, prompts). Uses current locale. */
export function t(key: MessageKey, vars?: TranslateVars): string {
  return translate(key, vars);
}
