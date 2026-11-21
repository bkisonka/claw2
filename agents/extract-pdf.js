// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

// Agent: Extract text from PDF (pdf-parse) → output/*.txt
// Call: run_agent({script:"extract-pdf.js", args:["uploads/file.pdf"]})
// In: argv[2]=path to PDF; argv[3]?=output base name
// Out: stdout: path to .txt and/or text

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

const filePath = process.argv[2];
const outputNameArg = process.argv[3];

if (!filePath) {
  console.error("Usage: node extract-pdf.js <path-to-pdf> [output-base-name]");
  process.exit(1);
}

if (!existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const outDir = process.env.OUTPUT_DIR
  ? join(process.env.OUTPUT_DIR)
  : join(__dirname, "output");
let baseName = `extract-${Date.now()}`;
if (outputNameArg) {
  const trimmed = String(outputNameArg).trim();
  if (trimmed.length > 0) {
    baseName = trimmed.replace(/[/\\]/g, "").replace(/\.(pdf|txt)$/i, "");
  }
}
const outPath = join(outDir, `${baseName}.txt`);

try {
  const buffer = readFileSync(filePath);
  const data = await pdfParse(buffer);
  const text = data.text || "";
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, text, "utf-8");
  console.log(`Saved to ${outPath}`);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}