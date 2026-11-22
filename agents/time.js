// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

// Agent: Current time ISO
// Call: run_agent({script:"time.js", args:["ru"]})
// In: no args — ISO 8601 in Europe/Moscow; "ru" — human-readable ru-RU
// Out: stdout: ISO datetime (e.g. 2026-11-22T21:45:03+03:00)

const now = new Date();
const timeZone = 'Europe/Moscow';
if (process.argv[2] === 'ru') {
  console.log(now.toLocaleString('ru-RU', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }));
} else {
  // ISO 8601 with the Moscow offset — the header's contract.
  console.log(new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).format(now).replace(' ', 'T') + '+03:00');
}
