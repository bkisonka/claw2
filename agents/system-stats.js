// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

// Agent: System status (CPU/memory/disks)
// Call: run_agent({script:"system-stats.js"})
// In: no args (or path to /proc snapshot)
// Out: stdout: resource summary

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { format } = require('util');

// Parser parameters
const MAX_WIDTH = 80;
const BLOCKS = 20;

// Utilities
function parseMemValue(valueStr) {
  const match = valueStr.match(/^(\d+)(?:\s*(kB|MB|GB|TB)?)$/i);
  if (!match) return null;
  let value = parseInt(match[1], 10);
  const unit = (match[2] || 'kB').toLowerCase();
  const multipliers = { kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4, b: 1 };
  return value * (multipliers[unit] || 1024);
}

function bytesToHuman(bytes) {
  if (bytes >= 1024 ** 4) return `${(bytes / (1024 ** 4)).toFixed(2)} TB`;
  if (bytes >= 1024 ** 3) return `${(bytes / (1024 ** 3)).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / (1024 ** 2)).toFixed(2)} MB`;
  return `${bytes} kB`;
}

function parsePercentage(line) {
  const match = line.match(/(\d+(\.\d+)?)\s*%/);
  return match ? parseFloat(match[1]) : null;
}

function formatTable(headers, rows, colWidths) {
  const cellSep = ' | ';
  const lineSep = colWidths.map(() => '-'.repeat(MAX_WIDTH / colWidths.length - cellSep.length)).join(cellSep);
  const output = [];
  output.push(headers.map((h, i) => h.padEnd(colWidths[i])).join(cellSep));
  output.push(lineSep);
  for (const row of rows) {
    output.push(row.map((cell, i) => (cell || '').padEnd(colWidths[i])).join(cellSep));
  }
  return output.join('\n');
}

function buildBarGraph(value, maxValue = 100, width = BLOCKS, char = '█') {
  const filled = Math.round((value / maxValue) * width);
  const empty = width - filled;
  return `${char.repeat(filled)}${'░'.repeat(empty)}`;
}

// Parsers
function parseMeminfo(content) {
  const lines = content.split('\n');
  const data = {};
  for (const line of lines) {
    if (line.includes(':')) {
      const [key, value] = line.split(':').map(s => s.trim());
      data[key] = value;
    }
  }
  // Generate statistics
  const total = parseMemValue(data['MemTotal']);
  const free = parseMemValue(data['MemFree']);
  const available = parseMemValue(data['MemAvailable'] || '0');
  const used = total - free;
  const percentUsed = ((used / total) * 100).toFixed(1);

  console.log('=== Memory status (MemInfo) ===\n');
  console.log(`Total memory: ${bytesToHuman(total)}`);
  console.log(`Free: ${bytesToHuman(free)}`);
  console.log(`Available: ${bytesToHuman(available || (free + parseMemValue(data['Buffers']) || parseMemValue(data['Cached'])))}`);
  console.log(`Used: ${bytesToHuman(used)} (${percentUsed}%)`);
  console.log(`${buildBarGraph(parseFloat(percentUsed), 100, 20)} ${percentUsed}%`);
}

function parseLoadavg(content) {
  const lines = content.trim().split(/\s+/);
  const load1 = parseFloat(lines[0]);
  const load5 = parseFloat(lines[1]);
  const load15 = parseFloat(lines[2]);
  const running = lines[3].split('/')[0];
  const total = lines[3].split('/')[1];

  console.log('=== Load average ===\n');
  const header = ['Period', 'Load', 'Graph'];
  const rows = [
    ['1 min', load1.toFixed(2), buildBarGraph(Math.min(load1, 10), 10)],
    ['5 min', load5.toFixed(2), buildBarGraph(Math.min(load5, 10), 10)],
    ['15 min', load15.toFixed(2), buildBarGraph(Math.min(load15, 10), 10)],
  ];
  const widths = [10, 12, BLOCKS];
  console.log(formatTable(header, rows, widths));
  console.log(`\nRunning tasks: ${running} / ${total}`);
}

function parseDf(content) {
  const lines = content.trim().split('\n');
  const rows = [];
  const headers = ['Filesystem', 'Size', 'Used', 'Avail', 'Use%', 'Mounted on'];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(/\s+/);
    if (parts.length < 6) continue;
    const fs = parts[0];
    const size = parts[1];
    const used = parts[2];
    const avail = parts[3];
    const percent = parts[4];
    const mount = parts.slice(5).join(' ');
    rows.push([fs, size, used, avail, percent, mount]);
  }

  console.log('=== Disk status (df -h) ===\n');
  const widths = [20, 12, 12, 12, 10, 20];
  console.log(formatTable(headers, rows, widths));
}

function parseSmartctl(content) {
  const lines = content.split('\n');
  const data = {};
  let attributes = [];
  let isAttributes = false;

  for (const line of lines) {
    const cleanLine = line.trim();
    if (cleanLine.includes('SMART Attributes') && cleanLine.includes('Value')) {
      isAttributes = true;
      continue;
    }
    if (isAttributes) {
      const match = cleanLine.match(/^(\d+)\s+(\w+)\s+(\w+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+\s+\d+\s+\d+\s+(\w+)/);
      if (match) {
        attributes.push({
          id: match[1],
          name: match[2],
          type: match[3],
          value: match[4],
          worst: match[5],
          threshold: match[6],
          raw: match[7],
        });
      } else if (cleanLine.startsWith('ID#')) break; // End of table
    }
    // Simple parse of general info
    const [key, value] = cleanLine.split(':').map(s => s.trim());
    if (value && !cleanLine.startsWith('ID#') && !cleanLine.includes('Value') && !cleanLine.includes('Worst')) {
      data[key] = value;
    }
  }

  console.log('=== SMART disk data ===\n');
  console.log('Information:');
  for (const [k, v] of Object.entries(data)) {
    if (['Device Model', 'Serial Number', 'Firmware Version', 'User Capacity'].includes(k)) {
      console.log(`${k.padEnd(20)}: ${v}`);
    }
  }

  if (attributes.length > 0) {
    console.log('\nSMART attributes:');
    const headers = ['ID', 'Attribute', 'Value', 'Worst', 'Thresh', 'Raw'];
    const rows = attributes.map(attr => [attr.id, attr.name, attr.value, attr.worst, attr.threshold, attr.raw]);
    const widths = [5, 15, 10, 10, 10, 20];
    console.log(formatTable(headers, rows, widths));
  }
}

// Main logic
try {
  const filePath = process.argv[2];
  if (!filePath) throw new Error('Specify a file path (e.g.: node script.js uploads/meminfo.txt)');
  const content = readFileSync(filePath, 'utf-8');
  const ext = filePath.split('/').pop().toLowerCase();

  if (ext.includes('meminfo') || ext.includes('mem')) {
    parseMeminfo(content);
  } else if (ext.includes('loadavg') || ext.includes('load')) {
    parseLoadavg(content);
  } else if (ext.includes('df') || ext.includes('disk')) {
    parseDf(content);
  } else if (ext.includes('smartctl') || ext.includes('smart')) {
    parseSmartctl(content);
  } else {
    throw new Error(`Unsupported file type: ${ext}. Expected extensions: meminfo, loadavg, df, smartctl.`);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}