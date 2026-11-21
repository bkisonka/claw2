// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import type { ReplaceFn } from "./types.js";
import {
  isPlausiblePhone,
  isValidInn,
  isValidPassportRf,
  isValidPassportRfText,
  isValidSnils,
} from "./validators.js";

const EMAIL_RE = /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g;
const CARD_RE = /\b(?:\d{4}[\s\-]?){3}\d{4}\b/g;
const IPV4_RE =
  /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g;

const PASSPORT_SPACED_RE = /(?<!\d)(\d{2})[\s\-]+(\d{2})[\s\-]+(\d{6})(?!\d)/g;
const PASSPORT_FOUR_SIX_RE = /(?<!\d)(\d{4})[\s\-]+(\d{6})(?!\d)/g;
const PASSPORT_COMPACT_RE = /(?<!\d)(\d{10})(?!\d)/g;
const INN_12_RE = /(?<!\d)(\d{12})(?!\d)/g;
const INN_10_RE = /(?<!\d)(\d{10})(?!\d)/g;
const SNILS_FORMATTED_RE = /(?<!\d)(\d{3}[\s\-]\d{3}[\s\-]\d{3}[\s\-]\d{2})(?!\d)/g;
const SNILS_COMPACT_RE = /(?<!\d)(\d{11})(?!\d)/g;

const PHONE_SOURCES = [
  String.raw`(?<!\d)\+7\s*\(\d{4,5}\)\s*\d{1,2}[\s\-]?\d{2}[\s\-]?\d{2}(?!\d)`,
  String.raw`(?<!\d)\+7\s*\(\d{3}\)\s*\d{3}[\s\-]?\d{1,2}(?:[\s\-]?\d{1,2})?(?:[\s\-]?\d{1,2})?(?!\d)`,
  String.raw`(?<!\d)(?:\+7|8)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}(?!\d)`,
  String.raw`(?<!\d)\+7[\s\-]?\d{3}[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}(?!\d)`,
  String.raw`(?<!\d)9\d{2}[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}(?!\d)`,
  String.raw`(?<!\d)(?:\(\d{3,5}\)|\d{3,5}[\s\-])\d{2,3}[\s\-]\d{2}[\s\-]\d{2}(?!\d)`,
  String.raw`(?<!\d)\+\d{1,3}[\s\-]?\(?\d{1,4}\)?[\s\-]?\d{2,4}[\s\-]?\d{2,4}(?!\d)`,
];

const DATETIME_SOURCES = [
  String.raw`\b\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b`,
  String.raw`\b\d{1,2}\.\d{1,2}\.\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\b`,
  String.raw`\b\d{1,2}\/\d{1,2}\/\d{4}\b`,
  String.raw`\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)\b`,
  String.raw`\b(?:\d{1,2}\s+)?(?:январ(?:я|ь)|феврал(?:я|ь)|марта?|апрел(?:я|ь)|ма[йя]|июн(?:я|ь)?|июл(?:я|ь)?|августа?|сентябр(?:я|ь)|октябр(?:я|ь)|ноябр(?:я|ь)|декабр(?:я|ь))\s+\d{4}\b`,
];

const CYR_NAME = "[А-ЯЁ][а-яё]{1,35}(?:-[А-ЯЁ][а-яё]+)?";
const LAT_NAME = "[A-Z][a-z]{2,35}(?:'[A-Z]?[a-z]+|-[A-Z][a-z]+)?";
const NAME_PART = `(?:${CYR_NAME}|${LAT_NAME})`;
const FIO_SOURCE = `\\b(${NAME_PART}(?:[ \\t]+${NAME_PART}){1,2})\\b`;

const ADDR_MARKER =
  "(?:ул\\.|улиц[аы]\\b|пр\\.|проспект\\b|пер\\.|переулок\\b|д\\.|\\bдом\\b|кв\\.|квартира\\b|г\\.|\\bгород\\b)";
const ADDRESS_SOURCE =
  "(?:\\d{6}\\s*,\\s*)?(?:г\\.?\\s*[А-ЯЁа-яё][А-ЯЁа-яё\\s-]{1,40},\\s*)?" +
  `${ADDR_MARKER}\\s*[^,\\n;]{2,80}(?:\\s*,\\s*${ADDR_MARKER}\\s*[^,\\n;]{1,60}){0,4}`;

function subGlobal(source: string, flags: string, text: string, repl: (...args: string[]) => string): string {
  return text.replace(new RegExp(source, flags.includes("g") ? flags : `${flags}g`), repl);
}

export function applyBuiltinRules(text: string, replace: ReplaceFn): string {
  if (!text) return text;
  let out = text;

  out = out.replace(new RegExp(EMAIL_RE.source, "g"), (v) => replace("EMAIL", v));
  out = out.replace(new RegExp(CARD_RE.source, "g"), (v) => replace("CARD", v));
  out = out.replace(new RegExp(IPV4_RE.source, "g"), (v) => replace("IPV4", v));

  out = out.replace(new RegExp(SNILS_FORMATTED_RE.source, "g"), (fragment) =>
    isValidSnils(fragment) ? replace("SNILS", fragment) : fragment
  );
  out = out.replace(new RegExp(SNILS_COMPACT_RE.source, "g"), (fragment) =>
    isValidSnils(fragment) ? replace("SNILS", fragment) : fragment
  );

  out = out.replace(new RegExp(PASSPORT_SPACED_RE.source, "g"), (fragment, g1, g2, g3) => {
    if (!isValidPassportRf(Number(g1), Number(g2), Number(g3))) return fragment;
    return replace("PASSPORT_RU", fragment);
  });
  out = out.replace(new RegExp(PASSPORT_FOUR_SIX_RE.source, "g"), (fragment, series, number) => {
    const s = String(series);
    if (!isValidPassportRf(Number(s.slice(0, 2)), Number(s.slice(2, 4)), Number(number))) {
      return fragment;
    }
    return replace("PASSPORT_RU", fragment);
  });

  for (const source of PHONE_SOURCES) {
    out = subGlobal(source, "g", out, (fragment) => {
      if (fragment.includes("[PII_")) return fragment;
      if (!isPlausiblePhone(fragment)) return fragment;
      return replace("PHONE", fragment);
    });
  }

  out = out.replace(new RegExp(INN_12_RE.source, "g"), (value) =>
    isValidInn(value) ? replace("INN", value) : value
  );
  out = out.replace(new RegExp(INN_10_RE.source, "g"), (value) => {
    if (!isValidInn(value)) return value;
    if (value.length === 10 && value.startsWith("9")) return value;
    return replace("INN", value);
  });

  out = out.replace(new RegExp(PASSPORT_COMPACT_RE.source, "g"), (value) => {
    if (isValidInn(value) || !isValidPassportRfText(value)) return value;
    return replace("PASSPORT_RU", value);
  });

  for (const source of DATETIME_SOURCES) {
    out = subGlobal(source, "gi", out, (fragment) => {
      if (fragment.includes("[PII_")) return fragment;
      return replace("DATETIME", fragment);
    });
  }

  return out;
}

/** Applied after custom rules (XZDR order). */
export function applyIdentityHeuristics(text: string, replace: ReplaceFn): string {
  if (!text) return text;
  let out = text;
  out = subGlobal(ADDRESS_SOURCE, "giu", out, (fragment) => {
    if (fragment.includes("[PII_")) return fragment;
    return replace("IDENTITY", fragment);
  });
  out = subGlobal(FIO_SOURCE, "gu", out, (fragment) => {
    if (fragment.includes("[PII_")) return fragment;
    if (fragment.length < 5) return fragment;
    return replace("IDENTITY", fragment);
  });
  return out;
}
