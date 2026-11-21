// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

export type { Locale } from "./types";
export { LOCALES, DEFAULT_LOCALE } from "./types";
export { t, getLocale, translate } from "./translate";
export type { TranslateVars } from "./translate";
export { I18nProvider, useI18n, useT } from "./I18nProvider";
export type { MessageKey } from "./en";
