#!/usr/bin/env node
// Agent: Image OCR (Tesseract.js)
// Call: run_agent({script:"ocr.js", args:["uploads/img.png","eng+rus"]})
// In: argv[2]=path to image; argv[3]?=language; argv[4]?=txt name in output
// Out: stdout: JSON { ok, text, confidence, savedTo? }

import { createWorker } from "tesseract.js";
import { existsSync, writeFileSync } from "node:fs";
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

let worker;
try {
  worker = await createWorker(lang);
  const { data } = await worker.recognize(imagePath);
  await worker.terminate();
  const text = data.text?.trim() ?? "";
  const result = { ok: true, text, confidence: data.confidence };

  if (outputFileName) {
    const outputDir = process.env.OUTPUT_DIR || "output";
    const safeName = outputFileName.replace(/[/\\]/g, "_");
    const outPath = join(outputDir, safeName);
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
