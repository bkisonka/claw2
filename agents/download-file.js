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
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    await mkdir(outputDir, { recursive: true });
    // Derive the name from the URL when not given: no more extension-less
    // "download" files. Query-string noise stripped; dotted/extension kept.
    let fileName = filename || decodeURIComponent(basename(new URL(url).pathname)).replace(/[^\w.\-]+/g, "_");
    if (!fileName || fileName === "." || fileName === "..") {
      const ext = (response.headers.get("content-type") ?? "").split(";")[0].trim().split("/").pop();
      fileName = `download-${Date.now()}${ext && /^[a-z0-9]{1,5}$/i.test(ext) ? "." + ext : ".bin"}`;
    }
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