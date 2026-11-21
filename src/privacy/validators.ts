// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

const INN_10_WEIGHTS = [2, 4, 10, 3, 5, 9, 4, 6, 8] as const;
const INN_12_WEIGHTS_1 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8] as const;
const INN_12_WEIGHTS_2 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8] as const;
const SNILS_WEIGHTS = [9, 8, 7, 6, 5, 4, 3, 2, 1] as const;

function innChecksum(digits: number[], weights: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < weights.length; i++) total += digits[i]! * weights[i]!;
  return (total % 11) % 10;
}

export function isValidInn10(value: string): boolean {
  if (value.length !== 10 || !/^\d+$/.test(value)) return false;
  const nums = [...value].map((ch) => Number(ch));
  return innChecksum(nums.slice(0, 9), INN_10_WEIGHTS) === nums[9];
}

export function isValidInn12(value: string): boolean {
  if (value.length !== 12 || !/^\d+$/.test(value)) return false;
  const nums = [...value].map((ch) => Number(ch));
  if (innChecksum(nums.slice(0, 10), INN_12_WEIGHTS_1) !== nums[10]) return false;
  return innChecksum(nums.slice(0, 11), INN_12_WEIGHTS_2) === nums[11];
}

export function isValidInn(value: string): boolean {
  if (value.length === 10) return isValidInn10(value);
  if (value.length === 12) return isValidInn12(value);
  return false;
}

export function isValidPassportRf(region: number, yearMod: number, number: number): boolean {
  if (region < 1 || region > 99) return false;
  if (number < 1 || number > 999_999) return false;
  if (yearMod >= 97 || yearMod <= 30) return true;
  return false;
}

export function isValidPassportRfText(text: string): boolean {
  const compact = text.replace(/[\s\-]/g, "");
  if (compact.length !== 10 || !/^\d+$/.test(compact)) return false;
  return isValidPassportRf(
    Number(compact.slice(0, 2)),
    Number(compact.slice(2, 4)),
    Number(compact.slice(4, 10))
  );
}

function snilsControl(nine: number[]): number {
  let total = 0;
  for (let i = 0; i < 9; i++) total += nine[i]! * SNILS_WEIGHTS[i]!;
  const control = total % 101;
  return control === 100 ? 0 : control;
}

export function isValidSnils(value: string): boolean {
  const compact = value.replace(/[\s\-]/g, "");
  if (compact.length !== 11 || !/^\d+$/.test(compact)) return false;
  const nums = [...compact].map((ch) => Number(ch));
  const expected = snilsControl(nums.slice(0, 9));
  const actual = nums[9]! * 10 + nums[10]!;
  return expected === actual;
}

export function isPlausiblePhone(fragment: string): boolean {
  const digits = fragment.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return false;
  if (/^0+$/.test(digits)) return false;
  return true;
}
