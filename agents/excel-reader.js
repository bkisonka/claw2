// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

// Agent: Read Excel (XLS/XLSX) → text/JSON
// Call: run_agent({script:"excel-reader.js", args:["uploads/file.xlsx"]})
// In: argv[2]=path to spreadsheet
// Out: stdout: sheet contents

import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const xlsx = require("xlsx");

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: node excel-reader.js <path-to-xlsx>");
  process.exit(1);
}

if (!existsSync(filePath)) {
  console.error("File not found:", filePath);
  process.exit(1);
}

try {
  const buf = readFileSync(filePath);
  const workbook = xlsx.read(buf, { type: "buffer" });
  const firstSheet = workbook.SheetNames && workbook.SheetNames[0];
  if (!firstSheet) {
    console.log("[]");
  } else {
    const out = xlsx.utils.sheet_to_json(workbook.Sheets[firstSheet], { defval: "" });
    console.log(JSON.stringify(out, null, 2));
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
