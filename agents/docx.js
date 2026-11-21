// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

// Agent: Extract text from DOCX (mammoth)
// Call: run_agent({script:"docx.js", args:["uploads/file.docx"]})
// In: argv[2]=path to .docx
// Out: stdout: extracted text

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const mammoth = require("mammoth");

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: node docx.js <path-to-docx>");
  process.exit(1);
}

(async () => {
  try {
    const result = await mammoth.extractRawText({ path: filePath });
    console.log(result.value || "");
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();
