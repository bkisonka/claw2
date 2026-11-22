#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

// Agent: Image OCR (Tesseract.js)
// Call: run_agent({script:"ocr.js", args:["uploads/img.png","eng+rus","result.txt"]})
// In: argv[2]=path to image; argv[3]?=languages ("eng", "eng+rus", …);
//     argv[4]?=txt name in output
// Out: stdout: JSON { ok, text, confidence, savedTo? }
//
// Node notes: do NOT pass workerPath/corePath. The dist/worker.min.js is
// the BROWSER worker (expects DOM globals — addEventListener) and dies in
// worker_threads; in Node tesseract.js resolves its own node worker and the
// local tesseract.js-core from node_modules. The only network touch is the
// language data (pinned 4.0.0 by default), cached persistently via cachePath
// so one-off skill containers download it once.

import { createWorker } from "tesseract.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const imagePath = process.argv[2]?.trim();
const lang = process.argv[3]?.trim() || "eng+rus";
const outputFileName = process.argv[4]?.trim();

if (!imagePath) {
  console.error("Usage: node ocr.js <path_to_image> [lang] [output_filename]");
  process.exit(1);
}

if (!existsSync(imagePath)) {
  console.error(JSON.stringify({ ok: false, error: "File not found", path: imagePath }));
  process.exit(1);
}

const cacheDir = join(process.env.OUTPUT_DIR || "output", ".tesseract-cache", "lang");

let worker;
try {
  mkdirSync(cacheDir, { recursive: true });
  worker = await createWorker(lang, 1, { cachePath: cacheDir });
  const { data } = await worker.recognize(imagePath);
  await worker.terminate();
  const text = data.text?.trim() ?? "";
  const result = { ok: true, text, confidence: data.confidence };

  if (outputFileName) {
    const outputDir = process.env.OUTPUT_DIR || "output";
    const safeName = outputFileName.replace(/[/\\]/g, "_");
    const outPath = join(outputDir, safeName);
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(outPath, text, "utf-8");
    result.savedTo = outPath;
  }

  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  if (worker) await worker.terminate().catch(() => {});
  console.error(
    JSON.stringify({
      ok: false,
      error: err.message ?? String(err),
    })
  );
  process.exit(1);
}
