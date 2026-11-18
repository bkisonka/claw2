// Agent: Rename/copy output.docx → given name
// Call: run_agent({script:"rename-output.js", args:["new-name.docx"]})
// In: argv[2]=target file name
// Out: stdout: path to file in agents/output

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// Agent: rename-output.js — copies output.docx to agents/output/[target-name]
const [scriptPath, , targetName] = process.argv;

if (!targetName) {
  console.error('Error: target filename is required');
  process.exit(1);
}

const sourcePath = 'agents/output/output.docx';
const outputPath = `agents/output/${targetName}`;

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