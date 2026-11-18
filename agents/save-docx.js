// Agent: Save text to DOCX (agents/output)
// Call: run_agent({script:"save-docx.js", stdin:"<full document text>"})
// In: stdin=full text (long text via stdin only; short text may use args[0])
// Out: stdout: FILE_URL=/files/output/output_<timestamp>.docx

import { Document, Packer, Paragraph, TextRun } from "docx";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = require("path").dirname(__filename);

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", () => resolve(""));
  });
}

function processText(text) {
  const cleaned = String(text ?? "").trim();
  if (!cleaned) {
    console.error(
      'Usage: run_agent(script="save-docx.js", stdin="document text…") — or pass short text as args.'
    );
    process.exit(1);
  }

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: cleaned.split("\n").map(
          (line) =>
            new Paragraph({
              children: [
                new TextRun({
                  text: line,
                  size: 24,
                }),
              ],
            })
        ),
      },
    ],
  });

  const outputDir = process.env.OUTPUT_DIR
    ? join(process.env.OUTPUT_DIR)
    : join(__dirname, "output");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `output_${timestamp}.docx`;
  const outputPath = join(outputDir, fileName);

  mkdirSync(outputDir, { recursive: true });

  Packer.toBuffer(doc)
    .then((buffer) => {
      writeFileSync(outputPath, buffer);
      console.log(`FILE_URL=/files/output/${fileName}`);
      console.log(outputPath);
    })
    .catch((err) => {
      console.error(String(err?.message ?? err));
      process.exit(1);
    });
}

const argvText = process.argv.slice(2).join(" ").trim();
const stdinText = await readStdin();
processText((stdinText || argvText).trim());
