// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

// Agent: Rename/copy output.docx → given name
// Call: run_agent({script:"rename-output.js", args:["new-name.docx"]})
// In: argv[2]=target file name
// Out: stdout: path to file in agents/output

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Agent: rename-output.js — copies output.docx to the output dir under the given name.
const [scriptPath, , targetName] = process.argv;

if (!targetName) {
  console.error('Error: target filename is required');
  process.exit(1);
}

// Strip any path structure: the target stays inside the output dir, no ../
const safeName = String(targetName).replace(/[/\\]/g, '').replace(/^\.+/, '').trim();
if (!safeName) {
  console.error('Error: target filename must contain a usable name');
  process.exit(1);
}

const outputDir = process.env.OUTPUT_DIR || 'agents/output';
const sourcePath = join(outputDir, 'output.docx');
const outputPath = join(outputDir, safeName);

try {
  if (!existsSync(sourcePath)) {
    console.error(`Error: source file ${sourcePath} not found`);
    process.exit(1);
  }

  const content = readFileSync(sourcePath);
  writeFileSync(outputPath, content);
  console.log(`Successfully copied ${sourcePath} to ${outputPath}`);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
