// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

// Agent: line/area chart → PNG + CHART_JSON for chat
// Call: run_agent({script:"chart.js", stdin: JSON.stringify({title, data:[{time|label,value}], chartType:"line"|"area"})})
// In: stdin=JSON (or argv[2]=path to JSON)
// Out: stdout: CHART_IMAGE_URL=/files/output/chart-….png and CHART_JSON={…}

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { stdin } from 'node:process';
import * as readline from 'node:readline';

const require = createRequire(import.meta.url);

const WIDTH = 800;
const HEIGHT = 400;
// In sandbox: OUTPUT_DIR=/app/output (agents/output on host). Do not write to cwd/agents/output —
// with -w /app/agents that becomes /app/agents/agents/output and hits the RO mount.
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(process.cwd(), 'output');

async function readInput() {
  const argPath = process.argv[2];
  if (argPath && fs.existsSync(argPath)) {
    return fs.readFileSync(argPath, 'utf8');
  }
  const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });
  let input = '';
  for await (const line of rl) input += line;
  return input;
}

function buildLineConfig(title, labels, values, fill = false) {
  return {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: title || 'Value',
        data: values,
        borderColor: 'rgb(75, 192, 192)',
        backgroundColor: fill ? 'rgba(75, 192, 192, 0.2)' : 'transparent',
        fill: fill,
        tension: 0.2,
      }],
    },
    options: {
      responsive: false,
      plugins: {
        title: { display: !!title, text: title || '', font: { size: 16 } },
        legend: { display: false },
      },
      scales: {
        y: { beginAtZero: false, grid: { display: true } },
        x: { grid: { display: false }, ticks: { maxTicksLimit: 12 } },
      },
    },
  };
}

async function renderQuickChart(chartConfig) {
  const baseUrl = process.env.QUICKCHART_URL || 'https://quickchart.io/chart';
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: '3',
      width: WIDTH,
      height: HEIGHT,
      format: 'png',
      backgroundColor: 'white',
      chart: chartConfig,
    }),
  });
  if (!res.ok) {
    throw new Error(`QuickChart: ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const raw = await readInput();
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (e) {
    console.error('Expected JSON: { title?, data: [{ time, value } or { label, value }], chartType? }');
    process.exit(1);
  }

  const data = Array.isArray(spec.data) ? spec.data : [];
  if (data.length === 0) {
    console.error('data must be a non-empty array');
    process.exit(1);
  }

  const labels = data.map((d) => d.time != null ? String(d.time) : (d.label != null ? String(d.label) : ''));
  const values = data.map((d) => {
    const v = d.value;
    return typeof v === 'number' && isFinite(v) ? v : (v != null ? Number(v) : NaN);
  });
  if (values.every((v) => isNaN(v))) {
    console.error('No numeric values in data');
    process.exit(1);
  }

  const chartType = (spec.chartType || 'line').toLowerCase();
  const fill = chartType === 'area';
  const config = buildLineConfig(spec.title || 'Chart', labels, values, fill);

  const pngBuffer = await renderQuickChart(config);
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  const filename = `chart-${Date.now()}.png`;
  const filePath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(filePath, pngBuffer);

  // For chat embed: [CELL type="image"]/files/output/...[/CELL] or interactive [CELL type="chart"]JSON[/CELL]
  console.log(`CHART_IMAGE_URL=/files/output/${filename}`);
  const lwcSpec = { series: [{ type: chartType === 'area' ? 'area' : 'line', data: labels.map((t, i) => ({ time: t, value: values[i] })) }], title: spec.title };
  console.log('CHART_JSON=' + JSON.stringify(lwcSpec));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
