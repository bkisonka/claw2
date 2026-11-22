#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

// Agent: Image OCR (Tesseract.js)
// Call: run_agent({script:"ocr.js", args:["uploads/img.png","eng+rus","result.txt"]})
// In: argv[2]=path to image; argv[3]?=languages ("eng", "eng+rus", …);
//     argv[4]?=txt name in output
// Out: stdout: JSON { ok, text, confidence, savedTo? }
//
// Node's Worker requires a LOCAL script path, so CDN URLs for the tesseract
// worker fail outright. Runtime assets (worker, core wasm, lang data) are
// downloaded once — pinned versions only — into a persistent cache under the
// output volume and referenced as local files after that.

import { createWorker } from "tesseract.js";
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const TESSERACT_JS_VERSION = "5.1.1";
const TESSERACT_CORE_VERSION = "5.1.1";
const TESSDATA_BASE = "https://tessdata.projectnaptha.com/4.0.0";
const CORE_FILES = [
  "tesseract-core.wasm.js",
  "tesseract-core-simd.wasm.js",
  "tesseract-core-lstm.wasm.js",
  "tesseract-core-simd-lstm.wasm.js",
];

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

const cacheDir = join(process.env.OUTPUT_DIR || "output", ".tesseract-cache");

async function fetchToFile(url, dest) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const part = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
  renameSync(part, dest);
}

/** Download once into the cache, then always serve the local path. */
async function ensureAsset(url, rel) {
  const dest = join(cacheDir, rel);
  if (existsSync(dest) && statSync(dest).size > 0) return dest;
  mkdirSync(dirname(dest), { recursive: true });
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await fetchToFile(url, dest);
      return dest;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr;
}

let worker;
try {
  const workerPath = await ensureAsset(
    `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_JS_VERSION}/dist/worker.min.js`,
    `tesseract.js@${TESSERACT_JS_VERSION}/worker.min.js`
  );
  for (const f of CORE_FILES) {
    await ensureAsset(
      `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESSERACT_CORE_VERSION}/${f}`,
      `tesseract.js-core@${TESSERACT_CORE_VERSION}/${f}`
    );
  }
  const corePath = join(cacheDir, `tesseract.js-core@${TESSERACT_CORE_VERSION}`);
  const langs = lang.split("+").map((l) => l.trim()).filter(Boolean);
  for (const code of langs) {
    await ensureAsset(
      `${TESSDATA_BASE}/${code}.traineddata.gz`,
      `tessdata-4.0.0/${code}.traineddata.gz`
    );
  }
  const langPath = join(cacheDir, "tessdata-4.0.0");

  worker = await createWorker(langs.join("+"), 1, { workerPath, corePath, langPath });
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
