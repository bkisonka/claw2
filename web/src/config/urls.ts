// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/** Public product URLs (desktop Help, PWA links). */
export const CLAW2_WIKI_URL = "https://claw2.online/wiki/";

/** Localized wiki home (EN default on the site). */
export function claw2WikiHomeUrl(locale: "en" | "ru" = "en"): string {
  const lang = locale === "ru" ? "ru" : "en";
  return `${CLAW2_WIKI_URL}#/${lang}/Home.md`;
}
