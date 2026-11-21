#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

// Agent: HTTP GET URL → response body on stdout
// Call: run_agent({script:"fetch-json.js", args:["https://…"]})
// In: argv[2]=URL
// Out: stdout: response body

/**
 * fetch-json agent: GET URL from argv[2] → JSON on stdout.
 * Input: argv[2] = URL. Output: stdout (response body or JSON error), exit 0 or 1.
 */

const url = process.argv[2];
if (!url) {
  console.error("Usage: node fetch-json.js <url>");
  process.exit(1);
}

try {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${text}`);
    process.exit(1);
  }
  console.log(text);
} catch (err) {
  console.error(err.message ?? err);
  process.exit(1);
}
