#!/usr/bin/env node
/** Copy gateway SQL schemas into dist/ after tsc (cross-platform). */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const copies = [
  ["src/gateway/db/schema.sql", "dist/gateway/db/schema.sql"],
  ["src/gateway/auth/schema.sql", "dist/gateway/auth/schema.sql"],
];

for (const [fromRel, toRel] of copies) {
  const from = path.join(root, fromRel);
  const to = path.join(root, toRel);
  if (!fs.existsSync(from)) {
    console.error("missing", from);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.error("copied", toRel);
}
