// Agent: Save article text to agents/output
// Call: run_agent({script:"save-article.js", stdin:"…text…"})
// In: stdin=article text
// Out: stdout: path/FILE_URL

import { writeFileSync } from "node:fs";

const outputFile = "./output/mrna-ihd-article-full.txt";

// Read stdin
let text = "";
process.stdin.on("data", (chunk) => {
  text += chunk;
});

process.stdin.on("end", () => {
  try {
    writeFileSync(outputFile, text, "utf-8");
    console.error(`Article saved to ${outputFile}`);
    process.exit(0);
  } catch (err) {
    console.error(`Error saving file: ${err.message}`);
    process.exit(1);
  }
});