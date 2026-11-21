// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

// Agent: Download file by URL into agents/output
// Call: run_agent({script:"download-file.js", args:["https://…", "optional-name.ext"]})
// In: argv[2]=URL; argv[3]?=file name
// Out: stdout: path/FILE_URL of saved file

import { join, basename } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const outputDir = process.env.OUTPUT_DIR || join(process.cwd(), "output");

async function downloadFile(url, filename) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    await mkdir(outputDir, { recursive: true });
    const fileName = filename || basename(new URL(url).pathname) || "download";
    const filePath = join(outputDir, fileName);
    await writeFile(filePath, buffer);
    // Path relative to agents/ for the user: output/file_name
    const relativePath = `output/${fileName}`;
    console.log(JSON.stringify({ ok: true, savedTo: relativePath, size: buffer.length }));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}

const url = process.argv[2];
const filename = process.argv[3];

if (!url) {
  console.error("Usage: node download-file.js <URL> [filename]");
  process.exit(1);
}

await downloadFile(url, filename);